#!/usr/bin/env node
import express, { Request, Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import { z } from "zod";
import dotenv from "dotenv";
import * as fs from "fs/promises";
import * as path from "path";

dotenv.config();

const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || "";
const OPENWEATHER_BASE_URL = "https://api.openweathermap.org/data/2.5";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const DATA_DIR = path.join(process.cwd(), "data", "reports");

async function ensureDataDir() { try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {} }

interface WeatherResponse { name: string; sys: { country: string }; main: { temp: number; feels_like: number; temp_min: number; temp_max: number; pressure: number; humidity: number }; weather: Array<{ main: string; description: string; icon: string }>; wind: { speed: number; deg: number }; clouds: { all: number }; visibility: number }
interface ForecastResponse { city: { name: string; country: string; timezone: number }; list: Array<{ dt: number; dt_txt: string; main: { temp: number; feels_like: number; temp_min: number; temp_max: number; pressure: number; humidity: number }; weather: Array<{ main: string; description: string; icon: string }>; wind: { speed: number; deg: number }; clouds: { all: number }; pop: number }> }
interface AirQualityResponse { list: Array<{ main: { aqi: number }; components: { co: number; no: number; no2: number; o3: number; so2: number; pm2_5: number; pm10: number; nh3: number }; dt: number }> }
interface GeocodingResponse { name: string; lat: number; lon: number; country: string; state?: string }
interface OpenRouterResponse { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
interface CityWeatherData { city: string; country: string; temp: number; feels_like: number; humidity: number; pressure: number; wind_speed: number; description: string; clouds: number; visibility: number }

async function getCurrentWeather(city: string, units = "metric", lang = "ru"): Promise<string> {
  if (!OPENWEATHER_API_KEY) throw new Error("OPENWEATHER_API_KEY not set");
  const url = `${OPENWEATHER_BASE_URL}/weather?q=${encodeURIComponent(city)}&units=${units}&lang=${lang}&appid=${OPENWEATHER_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) { if (response.status === 404) throw new Error(`City "${city}" not found`); throw new Error(`API error: ${response.status}`); }
  const data = (await response.json()) as WeatherResponse;
  const tempUnit = units === "metric" ? "°C" : units === "imperial" ? "°F" : "K";
  const windUnit = units === "metric" ? "м/с" : "mph";
  return JSON.stringify({ location: `${data.name}, ${data.sys.country}`, temperature: `${data.main.temp}${tempUnit}`, feels_like: `${data.main.feels_like}${tempUnit}`, temp_range: `${data.main.temp_min}${tempUnit} - ${data.main.temp_max}${tempUnit}`, description: data.weather[0].description, humidity: `${data.main.humidity}%`, pressure: `${data.main.pressure} hPa`, wind_speed: `${data.wind.speed} ${windUnit}`, clouds: `${data.clouds.all}%`, visibility: `${(data.visibility / 1000).toFixed(1)} km` }, null, 2);
}

async function getWeatherData(city: string, units = "metric"): Promise<CityWeatherData> {
  if (!OPENWEATHER_API_KEY) throw new Error("OPENWEATHER_API_KEY not set");
  const url = `${OPENWEATHER_BASE_URL}/weather?q=${encodeURIComponent(city)}&units=${units}&appid=${OPENWEATHER_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  const data = (await response.json()) as WeatherResponse;
  return { city: data.name, country: data.sys.country, temp: data.main.temp, feels_like: data.main.feels_like, humidity: data.main.humidity, pressure: data.main.pressure, wind_speed: data.wind.speed, description: data.weather[0].description, clouds: data.clouds.all, visibility: data.visibility / 1000 };
}

async function getCoordinates(city: string) {
  if (!OPENWEATHER_API_KEY) throw new Error("OPENWEATHER_API_KEY not set");
  const url = `http://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${OPENWEATHER_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Geocoding error: ${response.status}`);
  const data = (await response.json()) as GeocodingResponse[];
  if (!data?.length) throw new Error(`City "${city}" not found`);
  return { lat: data[0].lat, lon: data[0].lon, name: data[0].name, country: data[0].country };
}

async function getForecast(city: string, units = "metric", lang = "ru"): Promise<string> {
  if (!OPENWEATHER_API_KEY) throw new Error("OPENWEATHER_API_KEY not set");
  const url = `${OPENWEATHER_BASE_URL}/forecast?q=${encodeURIComponent(city)}&units=${units}&lang=${lang}&appid=${OPENWEATHER_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  const data = (await response.json()) as ForecastResponse;
  const tempUnit = units === "metric" ? "°C" : units === "imperial" ? "°F" : "K";
  const windUnit = units === "metric" ? "м/с" : "mph";
  const dailyForecasts: Record<string, typeof data.list> = {};
  for (const item of data.list) { const date = item.dt_txt.split(" ")[0]; if (!dailyForecasts[date]) dailyForecasts[date] = []; dailyForecasts[date].push(item); }
  const formattedForecast = Object.entries(dailyForecasts).map(([date, items]) => { const temps = items.map(i => i.main.temp); return { date, temp_range: `${Math.min(...temps).toFixed(1)}${tempUnit} - ${Math.max(...temps).toFixed(1)}${tempUnit}`, condition: items.map(i => i.weather[0].description).sort((a, b) => items.filter(v => v.weather[0].description === a).length - items.filter(v => v.weather[0].description === b).length).pop(), precipitation_chance: `${Math.max(...items.map(i => i.pop)) * 100}%`, hourly: items.map(item => ({ time: item.dt_txt.split(" ")[1].slice(0, 5), temp: `${item.main.temp}${tempUnit}`, condition: item.weather[0].description, wind: `${item.wind.speed} ${windUnit}`, humidity: `${item.main.humidity}%` })) }; });
  return JSON.stringify({ location: `${data.city.name}, ${data.city.country}`, timezone_offset: `${data.city.timezone / 3600} hours from UTC`, forecast: formattedForecast }, null, 2);
}

async function getAirQuality(city: string): Promise<string> {
  if (!OPENWEATHER_API_KEY) throw new Error("OPENWEATHER_API_KEY not set");
  const coords = await getCoordinates(city);
  const url = `${OPENWEATHER_BASE_URL}/air_pollution?lat=${coords.lat}&lon=${coords.lon}&appid=${OPENWEATHER_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  const data = (await response.json()) as AirQualityResponse;
  const aqiData = data.list[0];
  const aqiDesc: Record<number, string> = { 1: "Хорошее", 2: "Удовлетворительное", 3: "Умеренное", 4: "Плохое", 5: "Очень плохое" };
  return JSON.stringify({ location: `${coords.name}, ${coords.country}`, air_quality_index: aqiData.main.aqi, air_quality_description: aqiDesc[aqiData.main.aqi] || "Неизвестно", components: { co: `${aqiData.components.co} μg/m³`, no: `${aqiData.components.no} μg/m³`, no2: `${aqiData.components.no2} μg/m³`, o3: `${aqiData.components.o3} μg/m³`, so2: `${aqiData.components.so2} μg/m³`, pm2_5: `${aqiData.components.pm2_5} μg/m³`, pm10: `${aqiData.components.pm10} μg/m³`, nh3: `${aqiData.components.nh3} μg/m³` } }, null, 2);
}

async function getMultiCityWeather(cities: string[], units = "metric"): Promise<CityWeatherData[]> {
  const results: CityWeatherData[] = [];
  for (const city of cities) { try { results.push(await getWeatherData(city, units)); } catch (e) { console.error(`Error fetching ${city}:`, e); } }
  return results;
}

async function analyzeWeatherTrends(weatherData: CityWeatherData[], language = "ru"): Promise<string> {
  if (!OPENROUTER_API_KEY) {
    const hottest = weatherData.reduce((a, b) => a.temp > b.temp ? a : b);
    const coldest = weatherData.reduce((a, b) => a.temp < b.temp ? a : b);
    const avgTemp = weatherData.reduce((a, b) => a + b.temp, 0) / weatherData.length;
    return `Анализ погоды для ${weatherData.length} городов:\n- Самый тёплый: ${hottest.city} (${hottest.temp}°C)\n- Самый холодный: ${coldest.city} (${coldest.temp}°C)\n- Средняя температура: ${avgTemp.toFixed(1)}°C`;
  }
  const summary = weatherData.map(d => `${d.city}, ${d.country}: ${d.temp}°C, ${d.description}, влажность ${d.humidity}%`).join("\n");
  const langPrompt = language === "ru" ? "Respond in Russian." : "Respond in English.";
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENROUTER_API_KEY}` }, body: JSON.stringify({ model: "anthropic/claude-3-5-haiku-20241022", messages: [{ role: "system", content: `Weather analyst. Provide insights. ${langPrompt}` }, { role: "user", content: `Analyze:\n${summary}` }], max_tokens: 1000 }) });
    const data = (await response.json()) as OpenRouterResponse;
    if (data.error) throw new Error(data.error.message);
    return data.choices?.[0]?.message?.content || "No analysis";
  } catch (e) { throw new Error(`Analysis failed: ${e}`); }
}

async function saveWeatherReport(content: string, filename: string, format: "markdown" | "json" = "markdown"): Promise<string> {
  await ensureDataDir();
  const sanitized = filename.replace(/[^a-zA-Z0-9_-]/g, "_");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = format === "json" ? ".json" : ".md";
  const formatted = format === "json" ? JSON.stringify({ content, savedAt: new Date().toISOString() }, null, 2) : `# Weather Report\n\n**Generated:** ${new Date().toLocaleString()}\n\n---\n\n${content}`;
  const filePath = path.join(DATA_DIR, `${sanitized}_${timestamp}${ext}`);
  await fs.writeFile(filePath, formatted, "utf-8");
  return filePath;
}

async function runWeatherAnalysisPipeline(cities: string[], units = "metric", language = "ru", filename?: string) {
  const startTime = Date.now();
  console.log(`[Pipeline] Analyzing: ${cities.join(", ")}`);
  const weatherData = await getMultiCityWeather(cities, units);
  if (!weatherData.length) throw new Error("No data");
  const analysis = await analyzeWeatherTrends(weatherData, language);
  const tempUnit = units === "metric" ? "°C" : units === "imperial" ? "°F" : "K";
  const windUnit = units === "metric" ? "м/с" : "mph";
  const report = `## Weather: ${cities.join(", ")}\n\n| City | Temp | Feels | Humidity | Wind | Conditions |\n|------|------|-------|----------|------|------------|\n${weatherData.map(d => `| ${d.city} | ${d.temp}${tempUnit} | ${d.feels_like}${tempUnit} | ${d.humidity}% | ${d.wind_speed} ${windUnit} | ${d.description} |`).join("\n")}\n\n### Analysis\n\n${analysis}`;
  const savedTo = await saveWeatherReport(report, filename || `weather_${cities.join("_").slice(0, 30)}`, "markdown");
  return { cities, weatherData, analysis, savedTo, executionTime: Date.now() - startTime };
}

const createServer = () => {
  const server = new McpServer({ name: "mcp-weather-server", version: "2.0.0" }, { capabilities: { tools: {} } });

  server.tool("get_current_weather", "Get current weather for a city.", { city: z.string(), units: z.enum(["metric", "imperial", "standard"]).default("metric"), lang: z.string().default("ru") }, { title: "Current Weather" }, async ({ city, units = "metric", lang = "ru" }) => ({ content: [{ type: "text", text: await getCurrentWeather(city, units, lang) }] }));

  server.tool("get_forecast", "Get 5-day forecast.", { city: z.string(), units: z.enum(["metric", "imperial", "standard"]).default("metric"), lang: z.string().default("ru") }, { title: "Forecast" }, async ({ city, units = "metric", lang = "ru" }) => ({ content: [{ type: "text", text: await getForecast(city, units, lang) }] }));

  server.tool("get_air_quality", "Get air quality.", { city: z.string() }, { title: "Air Quality" }, async ({ city }) => ({ content: [{ type: "text", text: await getAirQuality(city) }] }));

  server.tool("get_multi_city_weather", "Get weather for multiple cities.", { cities: z.array(z.string()).min(1).max(10), units: z.enum(["metric", "imperial", "standard"]).default("metric") }, { title: "Multi-City" }, async ({ cities, units = "metric" }) => ({ content: [{ type: "text", text: JSON.stringify(await getMultiCityWeather(cities, units), null, 2) }] }));

  server.tool("analyze_weather_trends", "Analyze weather trends.", { cities: z.array(z.string()).min(2).max(10), units: z.enum(["metric", "imperial", "standard"]).default("metric"), language: z.string().default("ru") }, { title: "Analysis" }, async ({ cities, units = "metric", language = "ru" }) => ({ content: [{ type: "text", text: await analyzeWeatherTrends(await getMultiCityWeather(cities, units), language) }] }));

  server.tool("save_weather_report", "Save report to file.", { content: z.string(), filename: z.string(), format: z.enum(["markdown", "json"]).default("markdown") }, { title: "Save" }, async ({ content, filename, format = "markdown" }) => ({ content: [{ type: "text", text: JSON.stringify({ success: true, filePath: await saveWeatherReport(content, filename, format) }, null, 2) }] }));

  server.tool("run_weather_analysis_pipeline", "Run complete pipeline.", { cities: z.array(z.string()).min(2).max(10), units: z.enum(["metric", "imperial", "standard"]).default("metric"), language: z.string().default("ru"), filename: z.string().optional() }, { title: "Pipeline" }, async ({ cities, units = "metric", language = "ru", filename }) => { const r = await runWeatherAnalysisPipeline(cities, units, language, filename); return { content: [{ type: "text", text: JSON.stringify({ success: true, citiesAnalyzed: r.cities.length, analysis: r.analysis, savedTo: r.savedTo, executionTimeMs: r.executionTime }, null, 2) }] }; });

  server.tool("list_weather_reports", "List saved reports.", {}, { title: "List" }, async () => { await ensureDataDir(); const files = await fs.readdir(DATA_DIR); return { content: [{ type: "text", text: JSON.stringify({ directory: DATA_DIR, reports: files.filter(f => f.endsWith(".md") || f.endsWith(".json")), count: files.length }, null, 2) }] }; });

  return server;
};

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 3001;
const app = express();
app.use(express.json());
app.use(cors({ origin: "*", exposedHeaders: ["Mcp-Session-Id"] }));
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.get("/health", (_, res) => res.json({ status: "ok", server: "mcp-weather-server", version: "2.0.0", apiKeys: { openweather: !!OPENWEATHER_API_KEY, openrouter: !!OPENROUTER_API_KEY } }));

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  try {
    let transport: StreamableHTTPServerTransport;
    if (sessionId && transports[sessionId]) transport = transports[sessionId];
    else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (sid) => { transports[sid] = transport; } });
      transport.onclose = () => { const sid = transport.sessionId; if (sid && transports[sid]) delete transports[sid]; };
      await createServer().connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else { res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request" }, id: null }); return; }
    await transport.handleRequest(req, res, req.body);
  } catch (e) { console.error("[MCP]", e); if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Error" }, id: null }); }
});

app.get("/mcp", async (req, res) => { const sid = req.headers["mcp-session-id"] as string; if (!sid || !transports[sid]) { res.status(400).send("Invalid"); return; } await transports[sid].handleRequest(req, res); });
app.delete("/mcp", async (req, res) => { const sid = req.headers["mcp-session-id"] as string; if (!sid || !transports[sid]) { res.status(400).send("Invalid"); return; } await transports[sid].handleRequest(req, res); });

app.listen(MCP_PORT, () => {
  console.log(`\n${"=".repeat(60)}\n🌤️  MCP Weather Server v2.0 (Analytics Pipeline)\n${"=".repeat(60)}`);
  console.log(`📡 http://localhost:${MCP_PORT}\n🔑 OpenWeather: ${OPENWEATHER_API_KEY ? "✅" : "❌"} | OpenRouter: ${OPENROUTER_API_KEY ? "✅" : "⚠️"}`);
  console.log(`📋 Tools: get_current_weather, get_forecast, get_air_quality,\n   get_multi_city_weather, analyze_weather_trends, save_weather_report,\n   run_weather_analysis_pipeline, list_weather_reports\n📁 ${DATA_DIR}\n${"=".repeat(60)}\n`);
});

process.on("SIGINT", async () => { for (const sid in transports) { try { await transports[sid].close(); } catch {} delete transports[sid]; } process.exit(0); });
