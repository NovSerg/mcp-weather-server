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
  console.log(`✅ MCP Weather Server listening on http://localhost:${MCP_PORT}`);
  console.log(`   OpenWeather API Key: ${OPENWEATHER_API_KEY ? "✓ Configured" : "✗ Not configured"}`);
  console.log(`   Endpoints:`);
  console.log(`   - POST   /mcp  (JSON-RPC requests)`);
  console.log(`   - GET    /mcp  (SSE stream)`);
  console.log(`   - DELETE /mcp  (session termination)`);
  console.log(`   - GET    /health (health check)`);
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
