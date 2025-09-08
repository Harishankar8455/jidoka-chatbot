import { GoogleGenerativeAI } from "@google/generative-ai";
import { MongoClient } from "mongodb";
import "dotenv/config";

// Validate API key
if (!process.env.GOOGLE_API_KEY) {
  console.error("ERROR: GOOGLE_API_KEY is not set in environment variables");
  process.exit(1);
}

// Initialize Google Generative AI
let genAI;
let model;

try {
  genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
  console.log("Google Gemini API initialized successfully");
} catch (error) {
  console.error("Failed to initialize Google Gemini API:", error.message);
  process.exit(1);
}

// Enhanced MongoDB query function
async function queryMongoDB(query) {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI is not set in environment variables");
    }

    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();

    const db = client.db(process.env.DB_NAME || "test");
    const collection = db.collection("Reports");

    // Parse query to determine if we need special handling
    const queryAnalysis = analyzeQuery(query);

    let results;

    if (queryAnalysis.needsAggregation) {
      // Handle aggregation queries (max, min, sort, etc.)
      results = await handleAggregationQuery(collection, queryAnalysis);
    } else {
      // Handle regular find queries
      const mongoQuery = parseQuery(query);
      console.log(
        "Executing MongoDB query:",
        JSON.stringify(mongoQuery, null, 2)
      );

      results = await collection.find(mongoQuery).limit(20).toArray();
    }

    await client.close();

    if (results.length === 0) {
      return "No production reports found matching your query.";
    }

    // Format the results for better readability
    const formattedResults = results.map((item) => ({
      batch_id: item.batch_id,
      component_name: item.component_name,
      date: item.date,
      actual_production: item.actual_production,
      ok_parts: item.ok_parts,
      ng_parts: item.ng_parts,
      defect_occurrences: item.defect_occurrences,
    }));

    return JSON.stringify(formattedResults, null, 2);
  } catch (error) {
    console.error("MongoDB query error:", error.message);
    return `Error querying database: ${error.message}`;
  }
}

function analyzeQuery(query) {
  const lowerQuery = query.toLowerCase();

  return {
    isBatchQuery: /batch.*id.*[\w_:\-]+/i.test(query),
    isNGQuery: /ng|not good|defect|reject/i.test(lowerQuery),
    needsAggregation:
      /most|max|maximum|highest|lowest|min|minimum|average|sum|total/i.test(
        lowerQuery
      ),
    isComparative: /more|less|greater|than|compare/i.test(lowerQuery),
  };
}

function parseQuery(query) {
  const conditions = {};
  const queryAnalysis = analyzeQuery(query);

  // Enhanced Batch ID matching - handles complex IDs with colons and underscores
  const batchMatch = query.match(/(batch|lot)[:\s]*([\w_:\-]+)/i);
  if (batchMatch && batchMatch[2]) {
    const batchId = batchMatch[2].trim();
    // Handle various batch ID formats
    if (
      batchId.includes("_") ||
      batchId.includes(":") ||
      batchId.includes("-")
    ) {
      conditions.batch_id = batchId;
    } else {
      conditions.batch_id = { $regex: batchId, $options: "i" };
    }
  }

  // Component name matching
  const componentMatch = query.match(/(component|part)[:\s]*([\w_]+)/i);
  if (componentMatch)
    conditions.component_name = { $regex: componentMatch[2], $options: "i" };

  // Date filtering - enhanced to handle dates in batch IDs
  const dateMatch = query.match(
    /(today|yesterday|this week|last week|this month|last month|\d{2}[_\/\-]\d{2}[_\/\-]\d{4})/i
  );
  if (dateMatch) {
    if (dateMatch[1].match(/\d{2}[_\/\-]\d{2}[_\/\-]\d{4}/)) {
      // Extract date from batch ID format like 24_02_2025
      const dateStr = dateMatch[1].replace(/_/g, "-");
      const dateObj = new Date(dateStr);
      if (!isNaN(dateObj.getTime())) {
        const startOfDay = new Date(dateObj.setHours(0, 0, 0, 0));
        const endOfDay = new Date(dateObj.setHours(23, 59, 59, 999));
        conditions.date = { $gte: startOfDay, $lte: endOfDay };
      }
    } else {
      conditions.date = getDateFilter(dateMatch[1]);
    }
  }

  // NG parts specific queries
  if (queryAnalysis.isNGQuery) {
    conditions.ng_parts = { $exists: true, $gt: 0 };
  }

  // Performance metrics
  if (query.match(/performance|efficiency|quality/i)) {
    conditions.$or = [
      { performance: { $exists: true, $ne: null } },
      { quality: { $exists: true, $ne: null } },
    ];
  }

  // Production quantity
  const productionMatch = query.match(/(production|quantity)[\s\S]*?(\d+)/i);
  if (productionMatch) {
    conditions.$or = [
      { actual_production: { $gte: parseInt(productionMatch[2]) } },
      { planned_quantity: { $gte: parseInt(productionMatch[2]) } },
    ];
  }

  return conditions;
}

async function handleAggregationQuery(collection, queryAnalysis) {
  let pipeline = [];

  if (queryAnalysis.isNGQuery) {
    // For queries about NG parts
    pipeline = [
      { $match: { ng_parts: { $exists: true, $gt: 0 } } },
      { $sort: { ng_parts: -1 } }, // Sort by NG parts descending
      { $limit: 10 },
    ];
  } else if (queryAnalysis.needsAggregation) {
    // General aggregation for max/min queries
    pipeline = [{ $sort: { actual_production: -1 } }, { $limit: 10 }];
  }

  return await collection.aggregate(pipeline).toArray();
}

function getDateFilter(period) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfDay);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

  const startOfLastWeek = new Date(startOfWeek);
  startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

  const filters = {
    today: {
      $gte: startOfDay,
      $lte: now,
    },
    yesterday: {
      $gte: startOfYesterday,
      $lte: startOfDay,
    },
    "this week": {
      $gte: startOfWeek,
      $lte: now,
    },
    "last week": {
      $gte: startOfLastWeek,
      $lte: startOfWeek,
    },
    "this month": {
      $gte: startOfMonth,
      $lte: now,
    },
    "last month": {
      $gte: startOfLastMonth,
      $lte: endOfLastMonth,
    },
  };

  return filters[period.toLowerCase()];
}

// Test the Gemini API
async function testGeminiAPI() {
  try {
    const testPrompt = "Hello, this is a test message.";
    const result = await model.generateContent(testPrompt);
    const response = await result.response;
    console.log("Gemini API test successful");
    return true;
  } catch (error) {
    console.error("Gemini API test failed:", error.message);
    return false;
  }
}

// Initialize the production agent
export async function initializeProductionAgent() {
  console.log("Initializing Production Agent...");

  // Test the MongoDB connection
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI is not set in environment variables");
    }

    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    console.log("Connected to MongoDB successfully");
    await client.close();
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    throw new Error("MongoDB connection failed");
  }

  // Test the Gemini API
  const apiTest = await testGeminiAPI();
  if (!apiTest) {
    throw new Error("Gemini API test failed. Please check your API key.");
  }

  // Return a function that handles queries
  return async (question) => {
    try {
      // First, query MongoDB
      const dbResults = await queryMongoDB(question);

      // Prepare prompt for Gemini
      const prompt = `
        You are a helpful AI assistant specialized in production data analysis.
        Use the provided production data to answer the user's question.
        
        User Question: ${question}
        
        Production Data from MongoDB:
        ${dbResults}
        
        Instructions:
        1. Analyze the production data to answer the question precisely
        2. If asked about specific batch IDs, make sure to match them exactly
        3. For comparative questions (most NG parts, highest production), provide clear rankings
        4. Be specific about dates, batch IDs, and metrics
        5. If you have a final answer, prefix it with "FINAL ANSWER:"
        6. Current time: ${new Date().toISOString()}
        
        Important: When analyzing NG parts, look at the 'ng_parts' field specifically.
      `;

      // Generate content with Gemini
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      return text;
    } catch (error) {
      console.error("Error in agent processing:", error.message);

      if (
        error.message.includes("API_KEY_INVALID") ||
        error.message.includes("API key not valid")
      ) {
        return "Error: Invalid Google Gemini API key. Please check your API key configuration.";
      }

      return "Sorry, I encountered an error processing your request. Please try again.";
    }
  };
}
