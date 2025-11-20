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

// Load environment variables from .env file
dotenv.config();

// OpenWeather API configuration
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || "";
const OPENWEATHER_BASE_URL = "https://api.openweathermap.org/data/2.5";

// Input validation schemas
const GetWeatherSchema = z.object({
  city: z.string().describe("City name (e.g., 'Moscow', 'London')"),
  units: z
    .enum(["metric", "imperial", "standard"])
    .default("metric")
    .describe("Temperature units: metric (°C), imperial (°F), or standard (K)"),
  lang: z
    .string()
    .default("ru")
    .describe("Language for weather description (e.g., 'ru', 'en')"),
});

// Weather response type
interface WeatherResponse {
  name: string;
  sys: { country: string };
  main: {
    temp: number;
    feels_like: number;
    temp_min: number;
    temp_max: number;
    pressure: number;
    humidity: number;
  };
  weather: Array<{
    main: string;
    description: string;
    icon: string;
  }>;
  wind: {
    speed: number;
    deg: number;
  };
  clouds: {
    all: number;
  };
  visibility: number;
}

// Forecast response type
interface ForecastResponse {
  city: {
    name: string;
    country: string;
    timezone: number;
  };
  list: Array<{
    dt: number;
    dt_txt: string;
    main: {
      temp: number;
      feels_like: number;
      temp_min: number;
      temp_max: number;
      pressure: number;
      humidity: number;
    };
    weather: Array<{
      main: string;
      description: string;
      icon: string;
    }>;
    wind: {
      speed: number;
      deg: number;
    };
    clouds: {
      all: number;
    };
    pop: number; // Probability of precipitation
  }>;
}

// Air quality response type
interface AirQualityResponse {
  list: Array<{
    main: {
      aqi: number; // Air Quality Index: 1 = Good, 2 = Fair, 3 = Moderate, 4 = Poor, 5 = Very Poor
    };
    components: {
      co: number;    // Carbon monoxide
      no: number;    // Nitrogen monoxide
      no2: number;   // Nitrogen dioxide
      o3: number;    // Ozone
      so2: number;   // Sulphur dioxide
      pm2_5: number; // Fine particles
      pm10: number;  // Coarse particles
      nh3: number;   // Ammonia
    };
    dt: number;
  }>;
}

// Geocoding response type
interface GeocodingResponse {
  name: string;
  lat: number;
  lon: number;
  country: string;
  state?: string;
}

// Fetch current weather from OpenWeather API
async function getCurrentWeather(
  city: string,
  units: string = "metric",
  lang: string = "ru"
): Promise<string> {
  if (!OPENWEATHER_API_KEY) {
    throw new Error(
      "OPENWEATHER_API_KEY is not set. Please set it in environment variables."
    );
  }

  const url = `${OPENWEATHER_BASE_URL}/weather?q=${encodeURIComponent(
    city
  )}&units=${units}&lang=${lang}&appid=${OPENWEATHER_API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`City "${city}" not found`);
    }
    throw new Error(`OpenWeather API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as WeatherResponse;

  // Format the response
  const tempUnit = units === "metric" ? "°C" : units === "imperial" ? "°F" : "K";
  const windUnit = units === "metric" ? "м/с" : "mph";

  return JSON.stringify(
    {
      location: `${data.name}, ${data.sys.country}`,
      temperature: `${data.main.temp}${tempUnit}`,
      feels_like: `${data.main.feels_like}${tempUnit}`,
      temp_range: `${data.main.temp_min}${tempUnit} - ${data.main.temp_max}${tempUnit}`,
      description: data.weather[0].description,
      humidity: `${data.main.humidity}%`,
      pressure: `${data.main.pressure} hPa`,
      wind_speed: `${data.wind.speed} ${windUnit}`,
      clouds: `${data.clouds.all}%`,
      visibility: `${(data.visibility / 1000).toFixed(1)} km`,
    },
    null,
    2
  );
}

// Get coordinates for a city using Geocoding API
async function getCoordinates(city: string): Promise<{ lat: number; lon: number; name: string; country: string }> {
  if (!OPENWEATHER_API_KEY) {
    throw new Error("OPENWEATHER_API_KEY is not set.");
  }

  const url = `http://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${OPENWEATHER_API_KEY}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Geocoding API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as GeocodingResponse[];

  if (!data || data.length === 0) {
    throw new Error(`City "${city}" not found`);
  }

  return {
    lat: data[0].lat,
    lon: data[0].lon,
    name: data[0].name,
    country: data[0].country,
  };
}

// Fetch 5-day forecast from OpenWeather API
async function getForecast(
  city: string,
  units: string = "metric",
  lang: string = "ru"
): Promise<string> {
  if (!OPENWEATHER_API_KEY) {
    throw new Error("OPENWEATHER_API_KEY is not set.");
  }

  const url = `${OPENWEATHER_BASE_URL}/forecast?q=${encodeURIComponent(city)}&units=${units}&lang=${lang}&appid=${OPENWEATHER_API_KEY}`;
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`City "${city}" not found`);
    }
    throw new Error(`OpenWeather API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as ForecastResponse;
  const tempUnit = units === "metric" ? "°C" : units === "imperial" ? "°F" : "K";
  const windUnit = units === "metric" ? "м/с" : "mph";

  // Group forecasts by date
  const dailyForecasts: Record<string, typeof data.list> = {};
  for (const item of data.list) {
    const date = item.dt_txt.split(" ")[0];
    if (!dailyForecasts[date]) {
      dailyForecasts[date] = [];
    }
    dailyForecasts[date].push(item);
  }

  // Format the response
  const formattedForecast = Object.entries(dailyForecasts).map(([date, items]) => {
    const temps = items.map(i => i.main.temp);
    const minTemp = Math.min(...temps);
    const maxTemp = Math.max(...temps);

    // Get most common weather condition
    const conditions = items.map(i => i.weather[0].description);
    const mostCommon = conditions.sort((a, b) =>
      conditions.filter(v => v === a).length - conditions.filter(v => v === b).length
    ).pop();

    return {
      date,
      temp_range: `${minTemp.toFixed(1)}${tempUnit} - ${maxTemp.toFixed(1)}${tempUnit}`,
      condition: mostCommon,
      precipitation_chance: `${Math.max(...items.map(i => i.pop)) * 100}%`,
      hourly: items.map(item => ({
        time: item.dt_txt.split(" ")[1].slice(0, 5),
        temp: `${item.main.temp}${tempUnit}`,
        condition: item.weather[0].description,
        wind: `${item.wind.speed} ${windUnit}`,
        humidity: `${item.main.humidity}%`,
      })),
    };
  });

  return JSON.stringify(
    {
      location: `${data.city.name}, ${data.city.country}`,
      timezone_offset: `${data.city.timezone / 3600} hours from UTC`,
      forecast: formattedForecast,
    },
    null,
    2
  );
}

// Fetch air quality from OpenWeather API
async function getAirQuality(city: string): Promise<string> {
  if (!OPENWEATHER_API_KEY) {
    throw new Error("OPENWEATHER_API_KEY is not set.");
  }

  // First get coordinates for the city
  const coords = await getCoordinates(city);

  const url = `${OPENWEATHER_BASE_URL}/air_pollution?lat=${coords.lat}&lon=${coords.lon}&appid=${OPENWEATHER_API_KEY}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Air Quality API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as AirQualityResponse;
  const aqiData = data.list[0];

  // AQI descriptions
  const aqiDescriptions: Record<number, string> = {
    1: "Хорошее",
    2: "Удовлетворительное",
    3: "Умеренное",
    4: "Плохое",
    5: "Очень плохое",
  };

  return JSON.stringify(
    {
      location: `${coords.name}, ${coords.country}`,
      air_quality_index: aqiData.main.aqi,
      air_quality_description: aqiDescriptions[aqiData.main.aqi] || "Неизвестно",
      components: {
        co: `${aqiData.components.co} μg/m³ (угарный газ)`,
        no: `${aqiData.components.no} μg/m³ (оксид азота)`,
        no2: `${aqiData.components.no2} μg/m³ (диоксид азота)`,
        o3: `${aqiData.components.o3} μg/m³ (озон)`,
        so2: `${aqiData.components.so2} μg/m³ (диоксид серы)`,
        pm2_5: `${aqiData.components.pm2_5} μg/m³ (мелкие частицы)`,
        pm10: `${aqiData.components.pm10} μg/m³ (крупные частицы)`,
        nh3: `${aqiData.components.nh3} μg/m³ (аммиак)`,
      },
    },
    null,
    2
  );
}

// Create MCP server factory function
const createServer = () => {
  const server = new McpServer(
    {
      name: "mcp-weather-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register weather tool (using server.tool() which accepts Zod schemas)
  server.tool(
    "get_current_weather",
    "Get current weather information for a specified city using OpenWeather API. Returns temperature, conditions, humidity, wind speed, and more.",
    {
      city: z.string().describe("City name (e.g., 'Moscow', 'London', 'New York')"),
      units: z
        .enum(["metric", "imperial", "standard"])
        .default("metric")
        .describe("Temperature units: metric (Celsius), imperial (Fahrenheit), or standard (Kelvin)"),
      lang: z
        .string()
        .default("ru")
        .describe("Language code for weather description (e.g., 'ru' for Russian, 'en' for English)"),
    },
    {
      title: "Current Weather",
    },
    async ({ city, units = "metric", lang = "ru" }) => {
      const weatherData = await getCurrentWeather(city, units, lang);
      return {
        content: [
          {
            type: "text",
            text: weatherData,
          },
        ],
      };
    }
  );

  // Register forecast tool
  server.tool(
    "get_forecast",
    "Get 5-day weather forecast for a specified city. Returns forecast every 3 hours including temperature, conditions, precipitation chance, wind, and humidity.",
    {
      city: z.string().describe("City name (e.g., 'Moscow', 'London', 'New York')"),
      units: z
        .enum(["metric", "imperial", "standard"])
        .default("metric")
        .describe("Temperature units: metric (Celsius), imperial (Fahrenheit), or standard (Kelvin)"),
      lang: z
        .string()
        .default("ru")
        .describe("Language code for weather description (e.g., 'ru' for Russian, 'en' for English)"),
    },
    {
      title: "5-Day Weather Forecast",
    },
    async ({ city, units = "metric", lang = "ru" }) => {
      const forecastData = await getForecast(city, units, lang);
      return {
        content: [
          {
            type: "text",
            text: forecastData,
          },
        ],
      };
    }
  );

  // Register air quality tool
  server.tool(
    "get_air_quality",
    "Get current air quality information for a specified city. Returns Air Quality Index (AQI) and concentrations of pollutants like PM2.5, CO, NO2, O3, etc.",
    {
      city: z.string().describe("City name (e.g., 'Moscow', 'London', 'New York')"),
    },
    {
      title: "Air Quality",
    },
    async ({ city }) => {
      const airQualityData = await getAirQuality(city);
      return {
        content: [
          {
            type: "text",
            text: airQualityData,
          },
        ],
      };
    }
  );

  return server;
};

// Server configuration
const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 3001;

// Create Express app
const app = express();
app.use(express.json());

// Enable CORS for all origins
app.use(
  cors({
    origin: "*",
    exposedHeaders: ["Mcp-Session-Id"],
  })
);

// Map to store transports by session ID
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "mcp-weather-server",
    version: "1.0.0",
    apiKeyConfigured: !!OPENWEATHER_API_KEY,
  });
});

// MCP POST endpoint
app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId) {
    console.log(`[MCP] Request for session: ${sessionId}`);
  }

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          console.log(`[MCP] Session initialized: ${sessionId}`);
          transports[sessionId] = transport;
        },
      });

      // Clean up on close
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          console.log(`[MCP] Transport closed for session ${sid}`);
          delete transports[sid];
        }
      };

      // Connect server to transport
      const server = createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      // Invalid request
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      });
      return;
    }

    // Handle request with existing transport
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[MCP] Error handling request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

// MCP GET endpoint (SSE stream)
app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  const lastEventId = req.headers["last-event-id"];
  if (lastEventId) {
    console.log(`[MCP] Client reconnecting with Last-Event-ID: ${lastEventId}`);
  } else {
    console.log(`[MCP] Establishing SSE stream for session ${sessionId}`);
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

// MCP DELETE endpoint (session termination)
app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  console.log(`[MCP] Session termination request for ${sessionId}`);

  try {
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("[MCP] Error handling session termination:", error);
    if (!res.headersSent) {
      res.status(500).send("Error processing session termination");
    }
  }
});

// Start server
app.listen(MCP_PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🌤️  MCP Weather Server`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📡 Server URL: http://localhost:${MCP_PORT}`);
  console.log(`🏥 Health check: http://localhost:${MCP_PORT}/health`);
  console.log(`\n🔑 API Configuration:`);
  console.log(`   OpenWeather API: ${OPENWEATHER_API_KEY ? "✅ Configured" : "❌ Not configured"}`);
  console.log(`\n📋 Available endpoints:`);
  console.log(`   • POST   /mcp       - JSON-RPC requests`);
  console.log(`   • GET    /mcp       - SSE stream`);
  console.log(`   • DELETE /mcp       - Close session`);
  console.log(`   • GET    /health    - Health status`);
  console.log(`${'='.repeat(60)}\n`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[MCP] Shutting down server...");

  // Close all active transports
  for (const sessionId in transports) {
    try {
      console.log(`[MCP] Closing transport for session ${sessionId}`);
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`[MCP] Error closing transport for session ${sessionId}:`, error);
    }
  }

  console.log("[MCP] Server shutdown complete");
  process.exit(0);
});
