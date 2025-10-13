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

// Function to get defect information from Defects collection
async function getDefectInfo(client) {
  try {
    const db = client.db(process.env.DB_NAME || "test");
    const defectsCollection = db.collection("Defects");

    const defects = await defectsCollection.find({}).toArray();

    // Create a mapping of defect_id to defect information
    const defectMap = {};
    defects.forEach(defect => {
      defectMap[defect.defect_id] = {
        defect_class: defect.defect_class,
        description: defect.description,
        is_acceptable: defect.is_acceptable,
        defect_type: defect.defect_type
      };
    });

    return defectMap;
  } catch (error) {
    console.error("Error fetching defect information:", error.message);
    return {};
  }
}

// Function to map defect occurrences with defect information
function mapDefectOccurrences(defectOccurrences, defectMap, defectType) {
  const mappedDefects = {};

  if (defectOccurrences && Array.isArray(defectOccurrences)) {
    defectOccurrences.forEach((count, index) => {
      const defectId = index + 1; // Index + 1 corresponds to defect_id (since arrays are 0-indexed)
      if (count > 0 && defectMap[defectId]) {
        const defectInfo = defectMap[defectId];
        mappedDefects[defectInfo.defect_class] = {
          count: count,
          description: defectInfo.description,
          is_acceptable: defectInfo.is_acceptable,
          defect_type: defectType || defectInfo.defect_type
        };
      } else if (count > 0) {
        // If defect ID not found in mapping, still include the count with unknown defect
        mappedDefects[`Unknown_Defect_${defectId}`] = {
          count: count,
          description: `Unknown defect with ID ${defectId}`,
          is_acceptable: "unknown",
          defect_type: defectType || "unknown"
        };
      }
    });
  }

  return mappedDefects;
}

// Enhanced MongoDB query function
async function queryMongoDB(query) {
  let client;
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI is not set in environment variables");
    }

    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();

    const db = client.db(process.env.DB_NAME || "test");
    const collection = db.collection("Reports");

    // Get defect information
    const defectMap = await getDefectInfo(client);

    // Parse query to determine if we need special handling
    const queryAnalysis = analyzeQuery(query);

    let results;

    if (queryAnalysis.needsAggregation || queryAnalysis.isComponentList) {
      // Handle aggregation queries and component listing
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

    // Map defect occurrences to defect information
    const enhancedResults = results.map(item => {
      const enhancedItem = { ...item };

      // Map defect_occurrences
      if (item.defect_occurrences) {
        enhancedItem.mapped_defect_occurrences = mapDefectOccurrences(
          item.defect_occurrences,
          defectMap,
          "object_detection"
        );
      }

      // Map ocr_defect_occurrences
      if (item.ocr_defect_occurrences) {
        enhancedItem.mapped_ocr_defect_occurrences = mapDefectOccurrences(
          item.ocr_defect_occurrences,
          defectMap,
          "ocr"
        );
      }

      // Map dimensional_defect_occurrences (if it's an array)
      if (item.dimensional_defect_occurrences && Array.isArray(item.dimensional_defect_occurrences)) {
        enhancedItem.mapped_dimensional_defect_occurrences = mapDefectOccurrences(
          item.dimensional_defect_occurrences,
          defectMap,
          "dimensional"
        );
      }

      return enhancedItem;
    });

    if (enhancedResults.length === 0) {
      return "No production reports found matching your query.";
    }

    // Format the results for better readability
    const formattedResults = enhancedResults.map((item) => ({
      batch_id: item.batch_id,
      component_name: item.component_name,
      date: item.date,
      actual_production: item.actual_production,
      ok_parts: item.ok_parts,
      ng_parts: item.ng_parts,
      defect_occurrences: item.mapped_defect_occurrences,
      ocr_defect_occurrences: item.mapped_ocr_defect_occurrences,
      dimensional_defect_occurrences: item.mapped_dimensional_defect_occurrences,
      quality: item.Quality,
      performance: item.Performance,
      availability: item.Availability
    }));

    return JSON.stringify(formattedResults, null, 2);
  } catch (error) {
    console.error("MongoDB query error:", error.message);
    return `Error querying database: ${error.message}`;
  } finally {
    if (client) {
      await client.close();
    }
  }
}

function analyzeQuery(query) {
  const lowerQuery = query.toLowerCase();

  return {
    isBatchQuery: /batch.*id.*[\w_:\-]+/i.test(query),
    isNGQuery: /ng|not good|defect|reject/i.test(lowerQuery),
    needsAggregation: /most|max|maximum|highest|lowest|min|minimum|average|sum|total/i.test(lowerQuery),
    isComparative: /more|less|greater|than|compare/i.test(lowerQuery),
    isComponentList: /component|part|what.*component|which.*component|list.*component/i.test(lowerQuery),
    isGeneralQuery: /what.*data|which.*data|available.*data|have.*data/i.test(lowerQuery)
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

  // For general component queries, return all data
  if (queryAnalysis.isGeneralQuery || queryAnalysis.isComponentList) {
    // Return all documents for general queries
    return {};
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
  } else if (queryAnalysis.isComponentList) {
    // For component listing queries
    pipeline = [
      {
        $group: {
          _id: "$component_name",
          total_batches: { $sum: 1 },
          total_production: { $sum: "$actual_production" },
          latest_date: { $max: "$date" }
        }
      },
      { $sort: { total_production: -1 } }
    ];
  } else if (queryAnalysis.needsAggregation) {
    // General aggregation for max/min queries
    pipeline = [{ $sort: { actual_production: -1 } }, { $limit: 10 }];
  } else {
    // Default: return recent records
    pipeline = [{ $sort: { date: -1 } }, { $limit: 20 }];
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

    // Test defect collection access
    const defectMap = await getDefectInfo(client);
    console.log(`Loaded ${Object.keys(defectMap).length} defect definitions`);

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
        
        User Question: "${question}"
        
        Production Data from MongoDB:
        ${dbResults}
        
        Instructions:
        1. Analyze the production data to answer the question precisely
        2. If asked about components, list all available component names from the provided production data
        3. If asked about what data is available, provide a summary of components, date ranges, and key metrics
        4. If asked about specific batch IDs, make sure to match them exactly
        5. For comparative questions (most NG parts, highest production), provide clear rankings
        6. Be specific about dates, batch IDs, and metrics
        7. When discussing defects, use the mapped defect information (defect_class names) instead of just IDs
        8. If you have a final answer, prefix it with "FINAL ANSWER:"
        9. Current time: ${new Date().toISOString()}
        
        Important: When analyzing NG parts, look at the 'ng_parts' field specifically.
        Important: Defect occurrences are now mapped to their actual names for better understanding.
        Example: Instead of saying "defect_id 1 has 16661 occurrences", say "Ink_Spot defect has 16,661 occurrences".
        
        For component-related questions:
        - List all unique component names found in the data
        - Mention the date range and number of batches for each component
        - Provide total production numbers if available
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