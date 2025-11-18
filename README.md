# MCP Weather Server

Independent MCP (Model Context Protocol) server that provides weather data through OpenWeather API.

## Architecture

This is a standalone MCP server that runs independently from QueryLane. Any MCP client (including LLMs) can connect to it via HTTP.

```
┌─────────────┐         HTTP/MCP Protocol        ┌──────────────────┐
│             │◄─────────────────────────────────►│ mcp-weather-     │
│ QueryLane   │      http://localhost:3001/mcp   │ server           │
│ (MCP Client)│                                   │ (standalone)     │
│             │                                   │                  │
└─────────────┘                                   └──────────────────┘
                                                          │
                                                          │ uses API key
                                                          ▼
                                                  ┌──────────────────┐
                                                  │ OpenWeather API  │
                                                  └──────────────────┘
```

## Setup

### 1. Install Dependencies

```bash
cd mcp-weather-server
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and add your OpenWeather API key:

```bash
cp .env.example .env
```

Edit `.env`:
```env
OPENWEATHER_API_KEY=your_api_key_here
MCP_PORT=3001
```

Get your API key at: https://openweathermap.org/api

### 3. Build

```bash
npm run build
```

## Running the Server

### Development Mode
```bash
npm run dev
```

### Production Mode
```bash
npm start
```

The server will start on `http://localhost:3001` (or the port specified in `.env`).

## API Endpoints

### Health Check
```bash
GET http://localhost:3001/health
```

Returns server status and API key configuration status.

### MCP Endpoints

#### POST /mcp
JSON-RPC requests from MCP clients.

#### GET /mcp
Server-Sent Events (SSE) stream for notifications.

#### DELETE /mcp
Session termination.

## Available Tools

### `get_current_weather`

Get current weather information for a specified city.

**Parameters:**
- `city` (required): City name (e.g., "Moscow", "London")
- `units` (optional): Temperature units
  - `metric` (default): Celsius, m/s
  - `imperial`: Fahrenheit, mph
  - `standard`: Kelvin
- `lang` (optional): Language code (default: "ru")

**Example Response:**
```json
{
  "location": "Moscow, RU",
  "temperature": "5°C",
  "feels_like": "2°C",
  "temp_range": "3°C - 7°C",
  "description": "облачно с прояснениями",
  "humidity": "65%",
  "pressure": "1013 hPa",
  "wind_speed": "3.5 м/с",
  "clouds": "40%",
  "visibility": "10.0 km"
}
```

## Testing

### Via HTTP (curl)

```bash
# Health check
curl http://localhost:3001/health

# List tools (requires MCP initialization first)
# See MCP specification for proper JSON-RPC format
```

### Via QueryLane

1. Ensure MCP Weather Server is running
2. Start QueryLane: `npm run dev` (in parent directory)
3. Open http://localhost:3000
4. Click "Load Tools" in Weather Tools panel
5. Test with the play button

## Environment Variables

- `OPENWEATHER_API_KEY` (required): Your OpenWeather API key
- `MCP_PORT` (optional): Server port (default: 3001)

## MCP Protocol

This server implements the Model Context Protocol (MCP) using Streamable HTTP transport:
- Protocol version: 2025-03-26
- Transport: HTTP with Server-Sent Events (SSE)
- Session management: Stateful with session IDs

## Development

```bash
# Watch mode (auto-rebuild on changes)
npm run watch

# Build only
npm run build

# Run after build
npm start
```

## Security Notes

- CORS is enabled for all origins (suitable for local development)
- For production deployment, configure proper CORS and authentication
- Never commit `.env` file with real API keys
- Bind to localhost (127.0.0.1) for local-only access

## License

MIT
