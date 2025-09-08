import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import * as dotenv from "dotenv";
import { initializeProductionAgent } from "./agent.js";

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, ".env") });

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize agent
let productionAgent;
let initializationError = null;
let initializationWarnings = [];

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: productionAgent ? "OK" : "ERROR",
    agentInitialized: !!productionAgent,
    error: initializationError,
    warnings: initializationWarnings,
    timestamp: new Date().toISOString(),
  });
});

// Initialize agent on server start
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  try {
    productionAgent = await initializeProductionAgent();
    console.log("Production AI Agent initialized successfully");
  } catch (error) {
    console.error("Failed to initialize agent:", error.message);
    initializationError = error.message;

    // Even if initialization fails, create a basic agent for fallback
    productionAgent = async (question) => {
      return "The AI agent is experiencing technical difficulties. Please try again later or contact support.";
    };
  }
});

// Query endpoint
app.post("/api/query", async (req, res) => {
  try {
    const { question } = req.body;

    if (!productionAgent) {
      return res.status(503).json({
        error: "Agent is still initializing. Please try again shortly.",
      });
    }

    if (!question || question.trim().length === 0) {
      return res.status(400).json({ error: "Question is required" });
    }

    console.log(`Processing query: ${question}`);
    const response = await productionAgent(question);

    res.json({ response });
  } catch (error) {
    console.error("Error processing query:", error.message);
    res.status(500).json({ error: "Failed to process query" });
  }
});

// Simple test endpoint
app.get("/api/test", async (req, res) => {
  try {
    if (!productionAgent) {
      return res.status(503).json({ error: "Agent not initialized" });
    }

    const response = await productionAgent(
      "Test connection - what can you help me with?"
    );
    res.json({ success: true, response });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List available models endpoint (for debugging)
app.get("/api/models", async (req, res) => {
  try {
    // This would require additional setup to list models
    res.json({
      message: "Model listing requires additional Google Cloud setup",
      suggested_models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
