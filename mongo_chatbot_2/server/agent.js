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

// Component decision mapping
const COMPONENT_DECISIONS = {
  0: "OK",
  1: "NG",
  2: "Maybe",
  3: "Rework",
  4: "Unknown Status"
};

// Image decision mapping  
const IMAGE_DECISIONS = {
  0: "OK",
  1: "NG",
  2: "Maybe"
};

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

// UPDATED FUNCTION: Query component details from the component-specific collection
async function queryComponentDetails(componentName, client) {
  try {
    const db = client.db(process.env.DB_NAME || "test");

    // Use the component name as the collection name
    const componentsCollection = db.collection(componentName);

    console.log(`Querying collection: ${componentName}`);

    // Query all documents from this component collection
    const components = await componentsCollection.find({}).limit(20).toArray();

    if (components.length === 0) {
      return `No data found in collection '${componentName}'. The collection exists but is empty.`;
    }

    // Get defect information for mapping
    const defectMap = await getDefectInfo(client);

    // Format component data for better readability
    const formattedComponents = components.map(component => {
      // SAFE TIMESTAMP PARSING
      let timestamp = 'Unknown';
      try {
        if (component.timestamp) {
          if (component.timestamp.$date && component.timestamp.$date.$numberLong) {
            timestamp = new Date(parseInt(component.timestamp.$date.$numberLong)).toISOString();
          } else if (component.timestamp.$date) {
            timestamp = new Date(component.timestamp.$date).toISOString();
          } else if (typeof component.timestamp === 'number') {
            timestamp = new Date(component.timestamp).toISOString();
          } else if (typeof component.timestamp === 'string') {
            timestamp = new Date(component.timestamp).toISOString();
          }
        }
      } catch (error) {
        console.error("Error parsing timestamp:", error.message);
        timestamp = 'Invalid timestamp';
      }

      const formattedComponent = {
        component_id: component.component_id,
        batch_id: component.batch_id,
        timestamp: timestamp,
        component_decision: COMPONENT_DECISIONS[component.component_decision] || `Unknown (${component.component_decision})`,
        component_decision_code: component.component_decision,
        component_decision_subtype: component.component_decision_subtype,
        controller_id: component.controller_id,
        config_audit_id: component.config_audit_id,
        total_records_found: components.length
      };

      // Process images if available
      if (component.images && Array.isArray(component.images)) {
        formattedComponent.images = component.images.map(image => {
          const formattedImage = {
            image_id: image.image_id,
            station_id: image.station_id,
            line_id: image.line_id,
            ui_grid_pos_x: image.ui_grid_pos_x,
            ui_grid_pos_y: image.ui_grid_pos_y,
            image_path: image.image_path,
            image_path_result: image.image_path_result,
            decision: IMAGE_DECISIONS[image.decision] || `Unknown (${image.decision})`,
            decision_code: image.decision,
            decision_subtype: image.decision_subtype,
            module: image.module,
            level: image.level,
            model_name: image.model_name,
            legend: image.legend || 'No legend'
          };

          // Process rejection_cause (object_detection defects)
          if (image.rejection_cause && image.rejection_cause.algorithm) {
            const algo = image.rejection_cause.algorithm;
            formattedImage.object_detection_defects = {
              detection_boxes: algo.detection_boxes || [],
              detection_classes: algo.detection_classes || [],
              detection_classnames: algo.detection_classnames || [],
              detection_scores: algo.detection_scores || [],
              num_detections: algo.num_detections || 0
            };
          }

          // Process ocr_metadata (OCR defects)
          if (image.ocr_metadata && image.ocr_metadata.algorithm) {
            formattedImage.ocr_defects = (image.ocr_metadata.algorithm || []).map(ocr => ({
              decision: IMAGE_DECISIONS[ocr.decision] || `Unknown (${ocr.decision})`,
              decision_code: ocr.decision,
              detection_boxes: ocr.detection_boxes || [],
              detection_classes: ocr.detection_classes,
              detection_scores: ocr.detection_scores,
              detection_string: ocr.detection_string,
              detection_text_id: ocr.detection_text_id,
              dimension_id: ocr.dimension_id
            }));
          }

          // Process dimensional_metadata (dimensional defects)
          if (image.dimensional_metadata && image.dimensional_metadata.algorithm) {
            formattedImage.dimensional_defects = (image.dimensional_metadata.algorithm || []).map(dim => ({
              decision: IMAGE_DECISIONS[dim.decision] || `Unknown (${dim.decision})`,
              decision_code: dim.decision,
              dimension_id: dim.dimension_id,
              dimension_name: dim.dimension_name,
              measurement_actual_value: dim.measurement_actual_value,
              measurement_spec: dim.measurement_spec,
              measurement_tolerance: dim.measurement_tolerance
            }));
          }

          return formattedImage;
        });
      }

      return formattedComponent;
    });

    return JSON.stringify(formattedComponents, null, 2);
  } catch (error) {
    console.error("Error querying component details:", error.message);

    // More specific error messages
    if (error.message.includes('collection name must be a string')) {
      return `Error: Invalid component name '${componentName}'. Please check the component name and try again.`;
    } else if (error.message.includes('ns not found') || error.message.includes('Collection')) {
      return `Error: No collection found for component '${componentName}'. Please verify the component name exists in the database.`;
    } else {
      return `Error querying component '${componentName}': ${error.message}`;
    }
  }
}

// Enhanced MongoDB query function - FIXED VERSION
async function queryMongoDB(query) {
  let client;
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI is not set in environment variables");
    }

    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();

    // Check if this is a component-specific query
    const componentName = extractComponentName(query);

    if (componentName) {
      return await queryComponentDetails(componentName, client);
    }

    const db = client.db(process.env.DB_NAME || "test");
    const collection = db.collection("Reports");

    // Get defect information
    const defectMap = await getDefectInfo(client);

    // FIX: Define queryAnalysis here before using it
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

// UPDATED: Function to extract component name from query using quotes or asterisks
function extractComponentName(query) {
  // Look for component names in single quotes
  const singleQuoteMatch = query.match(/'([^']+)'/);
  if (singleQuoteMatch) {
    return singleQuoteMatch[1];
  }

  // Look for component names in double quotes
  const doubleQuoteMatch = query.match(/"([^"]+)"/);
  if (doubleQuoteMatch) {
    return doubleQuoteMatch[1];
  }

  // Look for component names in asterisks
  const asteriskMatch = query.match(/\*([^*]+)\*/);
  if (asteriskMatch) {
    return asteriskMatch[1];
  }

  return null;
}

// UPDATED: analyzeQuery function - removed isComponentQuery since we handle it separately
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

// Helper function to avoid matching common words
function isCommonWord(word) {
  const commonWords = [
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one',
    'our', 'out', 'get', 'has', 'him', 'his', 'how', 'man', 'new', 'now', 'old', 'see',
    'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use',
    'that', 'with', 'have', 'this', 'will', 'your', 'from', 'they', 'know', 'want',
    'been', 'good', 'much', 'some', 'time', 'very', 'when', 'come', 'here', 'just',
    'like', 'long', 'make', 'many', 'take', 'than', 'them', 'well', 'were', 'what',
    'when', 'where', 'which', 'while', 'who', 'whom', 'will', 'with', 'within', 'without',
    'would', 'year', 'years', 'yet', 'you', 'your', 'yours', 'yourself', 'yourselves'
  ];
  return commonWords.includes(word.toLowerCase());
}

function parseQuery(query) {
  const conditions = {};
  const queryAnalysis = analyzeQuery(query);
  const lowerQuery = query.toLowerCase();

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

  // FIXED: Date filtering - prioritize relative dates over batch ID date patterns
  const relativeDateMatch = query.match(/(today|yesterday|this week|last week|this month|last month)/i);
  const absoluteDateMatch = query.match(/\b(\d{2}[_\/\-]\d{2}[_\/\-]\d{4})\b/i);

  if (relativeDateMatch) {
    // Handle relative dates first (today, yesterday, etc.)
    console.log("Detected relative date period:", relativeDateMatch[1]);
    conditions.date = getDateFilter(relativeDateMatch[1]);
  } else if (absoluteDateMatch) {
    // Handle absolute dates in batch ID format like 24_02_2025
    console.log("Detected absolute date in batch ID format:", absoluteDateMatch[1]);
    const dateStr = absoluteDateMatch[1].replace(/_/g, "-");
    const dateObj = new Date(dateStr);
    if (!isNaN(dateObj.getTime())) {
      const startOfDay = new Date(dateObj.setHours(0, 0, 0, 0));
      const endOfDay = new Date(dateObj.setHours(23, 59, 59, 999));
      conditions.date = { $gte: startOfDay, $lte: endOfDay };
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
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const startOfYesterday = new Date(startOfDay);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const endOfYesterday = new Date(startOfDay);
  endOfYesterday.setMilliseconds(-1); // One millisecond before today starts

  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

  const startOfLastWeek = new Date(startOfWeek);
  startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);
  const endOfLastWeek = new Date(startOfWeek);
  endOfLastWeek.setMilliseconds(-1);

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

  const filters = {
    today: {
      $gte: startOfDay,
      $lte: endOfDay,
    },
    yesterday: {
      $gte: startOfYesterday,
      $lte: endOfYesterday,
    },
    "this week": {
      $gte: startOfWeek,
      $lte: endOfDay,
    },
    "last week": {
      $gte: startOfLastWeek,
      $lte: endOfLastWeek,
    },
    "this month": {
      $gte: startOfMonth,
      $lte: endOfDay,
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
      // Check if this looks like a component query but no clear component name
      const hasComponentKeywords = /component|part|inspect|defect|status|decision|image/i.test(question.toLowerCase());
      const componentName = extractComponentName(question);

      if (hasComponentKeywords && !componentName) {
        return `I can help you with component inspection details! Please specify the component name using quotes or asterisks, for example:
          - Please use this format to get exact results:    
          - use single quotes, double quotes, or asterisks to specify the component name.
          
          Here are some examples of valid component queries:
          - Show inspection summary of the component 'Component_Name'
          - What is the status of "9PLY_NORMAL"?
          - Display inspection results for *Marie*
          - Show defects for 'PCN_PRT_25FT'

          This helps me identify exactly which component you're asking about.`;
      }

      // First, query MongoDB
      const dbResults = await queryMongoDB(question);

      // Enhanced prompt for component queries
      const isComponentQuery = !!componentName;

      let prompt;
      if (isComponentQuery) {
        prompt = `
          You are a helpful AI assistant specialized in production component inspection data.
          Use the provided component inspection data to answer the user's question.
          
          User Question: "${question}"
          
          Component Inspection Data from MongoDB:
          ${dbResults}
          
          Important Information about Component Decisions:
          - component_decision: 0 = OK, 1 = NG, 2 = Maybe, 3 = Rework
          - image decision: 0 = OK, 1 = NG, 2 = Maybe
          
          Defect Types in Images:
          - object_detection_defects: Found in rejection_cause (visual defects)
          - ocr_defects: Found in ocr_metadata (text recognition issues) 
          - dimensional_defects: Found in dimensional_metadata (measurement issues)
          
          Instructions:
          1. Always prioritize brief and concise answers. Get straight to the point without unnecessary elaboration.
          2. Analyze the component inspection data to answer the question precisely
          3. Explain the overall component status and individual image results
          4. Describe any defects found in object detection, OCR, or dimensional measurements
          5. Be specific about timestamps, batch IDs, and inspection results
          6. If multiple components are found, summarize each one clearly
          7. If no components are found, suggest checking the component name spelling
          8. When offering more information, use natural phrasing like:
              - "Would you like me to go into more detail about any of this?"
              - "I can explain this further if you'd like."
              - "Let me know if you need more specifics on this topic."
          9. If you have a final answer, prefix it with "FINAL ANSWER:"
          
          Current time: ${new Date().toISOString()}
        `;
      } else {
        prompt = `
          You are a helpful AI assistant specialized in production data analysis.
          Use the provided production data to answer the user's question.
          
          User Question: "${question}"
          
          Production Data from MongoDB:
          ${dbResults}
          
          Instructions:
          1. Analyze the production data to answer the question precisely. Get straight to the point without unnecessary elaboration.
          2. If asked about components, list all available component names from the provided production data
          3. If asked about what data is available, provide a summary of components, date ranges, and key metrics
          4. If asked about specific batch IDs, make sure to match them exactly
          5. For comparative questions (most NG parts, highest production), provide clear rankings
          6. Be specific about dates, batch IDs, and metrics
          7. When discussing defects, use the mapped defect information (defect_class names) instead of just IDs
          8. When offering more information, use natural phrasing like:
              - "Would you like me to go into more detail about any of this?"
              - "I can explain this further if you'd like."
              - "Let me know if you need more specifics on this topic."
          9. If you have a final answer, prefix it with "FINAL ANSWER:"
          10. Current time: ${new Date().toISOString()}
          
          Important: When analyzing NG parts, look at the 'ng_parts' field specifically.
          Important: Defect occurrences are now mapped to their actual names for better understanding.
          Example: Instead of saying "defect_id 1 has 16661 occurrences", say "Ink_Spot defect has 16,661 occurrences".
          
          For component-related questions:
          - List all unique component names found in the data
          - Mention the date range and number of batches for each component
          - Provide total production numbers if available
        `;
      }

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