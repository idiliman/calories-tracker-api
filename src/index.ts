import {
  LeaderboardUser,
  LeaderboardScoreSchema,
  promptSchema,
  AiResponse,
  aiResponseSchema,
  foodItemSchema,
  summarySchema,
  FoodItem,
} from "./types";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getLeaderboard, getMealType } from "./utils";
import { WebSocketHandler } from "./websocket_handler";

type Env = {
  AI: Ai;
  cache: KVNamespace;
  SECRET_PASSWORD: string;
};

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use("*", async (c, next) => {
  const secretPassword = c.req.header("SECRET_PASSWORD");

  console.log("secretPassword:", secretPassword);
  console.log("c.env.SECRET_PASSWORD:", c.env.SECRET_PASSWORD);

  if (secretPassword !== c.env.SECRET_PASSWORD) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
});

let wsHandler: WebSocketHandler | null = null;

app
  .post("/intake", zValidator("json", promptSchema), async (c) => {
    try {
      const { userName, prompt } = c.req.valid("json");

      // Get previous intake
      // let prevIntake: DailyIntake[] = [];
      // const cacheValue = await c.env.cache.get(userName);
      // if (cacheValue) {
      //   const cachedValue: AiResponse = JSON.parse(cacheValue);
      //   prevIntake.push({
      //     date: cachedValue.date,
      //     foods: cachedValue.foods,
      //   });
      // }

      const currentDate = new Date().toISOString();

      // const aiResponse = await c.env.AI.run("@cf/meta/llama-3-8b-instruct-awq", {
      const aiResponse = await c.env.AI.run("@cf/meta/llama-3-8b-instruct-awq", {
        messages: [
          {
            role: "system",
            content: `
            You are an expert nutritionist assistant specializing in Asian (Malaysian, Singaporean, and Thai cuisine) cuisine  analysis. You must ONLY respond with a valid JSON object - no additional text, explanations, or markdown.

            CRITICAL INSTRUCTION:
            - You must ONLY output a valid JSON object
            - Do not include any explanatory text before or after the JSON
            - Do not use markdown code blocks
            - Do not include any additional formatting
            - If you cannot provide accurate information, still return a valid JSON with empty arrays or zero values

            QUANTITY CALCULATION RULES:
            1. ALWAYS multiply base nutritional values by the specified quantity
              Examples:
              - "5 eggs" = 5 × (78 kcal, 6.3g protein, 0.6g carbs, 5.8g fat)
              - "2 plates nasi goreng" = 2 × (450 kcal, 15g protein, 65g carbs, 14g fat)
              
            2. For unspecified quantities:
              - Main dishes = 1 standard serving
              - Discrete items = 1 piece
              - Drinks = 1 regular serving (250ml)

            3. Common multipliers:
              - "half" or "1/2" = multiply by 0.5
              - "quarter" or "1/4" = multiply by 0.25
              - "double" = multiply by 2
              - Numeric values (e.g., "2x", "3x") = multiply by that number

            COOKING METHOD ADJUSTMENTS (apply AFTER quantity multiplication):
            1. Deep-fried items:
              - Add 30% to base calories
              - Add 3-4g fat per 100g serving
              
            2. Stir-fried items:
              - Add 15% to base calories
              - Add 1-2g fat per 100g serving

            PORTION SIZES:
            1. Main dishes:
              - Rice: 1 plate = 200g
              - Noodles: 1 plate = 250g
              - Meat/Fish: 1 serving = 100g
              
            2. Side dishes:
              - Vegetables: 1 portion = 100g
              - Curry sauce: 1 serving = 100ml
              
            3. Beverages:
              - Standard cup = 250ml
              - Large = 400ml
              - Small = 180ml

            INPUT PARSING:
            - Split comma-separated or free-form text into separate food items
            - Handle inputs like: "nasi ayam, 5 fried eggs, latte"
            - Common local dishes should use standard serving sizes:
              * Nasi Lemak = 1 plate (rice + sambal + egg + cucumber + peanuts)
              * Nasi Ayam = 1 plate (rice + chicken + cucumber)
              * Roti Canai = 1 piece
              * Mee Goreng = 1 plate
            - Beverages:
              * Coffee/Tea = 1 regular cup (250ml)
              * Soft drinks = 1 can (330ml)
            - If quantity not specified:
              * For dishes (like nasi ayam) -> assume 1 standard serving
              * For discrete items (like eggs) -> assume 1 piece
              * For drinks -> assume 1 regular serving
            
            DATE HANDLING:
            - If date not specified, use current date: ${currentDate}
            - Accept various date formats (e.g., "today", "yesterday", "tomorrow", "DD/MM/YYYY")

            STRICT RESPONSE FORMAT:
            Return ONLY a JSON object with this exact structure - no additional text or explanations:
            {
              "YYYY-MM-DDTHH:mm:ss.sssZ": {
                "foods": [
                  {
                    "name": "string",
                    "calories": "number as string (e.g., '250.0')",
                    "protein": "number as string (e.g., '8.5')",
                    "carbs": "number as string (e.g., '30.0')",
                    "fat": "number as string (e.g., '12.2')",
                    "amount": "string (serving size with unit)"
                  }
                ],
                "summary": {
                  "calories": "sum as string",
                  "protein": "sum as string",
                  "carbs": "sum as string",
                  "fat": "sum as string"
                }
              }
            }

            REMEMBER: 
            - Output ONLY the JSON object - no other text or formatting
            - ALWAYS multiply nutrient values by the quantity specified
            - Round all final values to 1 decimal place
            `,
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      console.log("aiResponse:", aiResponse);

      let responseText: string = "";
      let parsedResponse: AiResponse = {};

      if (aiResponse && typeof aiResponse === "object" && "response" in aiResponse) {
        // Handle object response
        responseText = aiResponse.response as string;
      } else if (aiResponse instanceof ReadableStream) {
        // Handle stream response
        const reader = aiResponse.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          responseText += new TextDecoder().decode(value);
        }
      } else {
        throw new Error("Unexpected response type from AI");
      }

      console.log("Starting AI response parsing...");
      console.log("Raw AI response:", responseText);

      try {
        let jsonString = "";
        let parsingStage = "initial";

        console.log("Attempting to parse full response as JSON...");
        // Try to parse the entire response as JSON first
        try {
          JSON.parse(responseText);
          jsonString = responseText;
          parsingStage = "full response parsed";
        } catch (jsonError) {
          // If parsing the entire response fails, try to extract JSON from various formats
          parsingStage = "extracting JSON";

          // Look for JSON object in markdown code blocks
          const codeBlockMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
          if (codeBlockMatch) {
            const potentialJson = codeBlockMatch[1].trim();
            try {
              JSON.parse(potentialJson);
              jsonString = potentialJson;
              parsingStage = "code block parsed";
            } catch (e) {
              // If parsing fails, continue to the next method
            }
          }

          // If still not found, look for JSON object in the entire text
          if (!jsonString) {
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              jsonString = jsonMatch[0];
              parsingStage = "JSON extracted from text";
            }
          }
        }

        if (!jsonString) {
          throw new Error(`No valid JSON object found in the response. Parsing stage: ${parsingStage}`);
        }

        parsingStage = "parsing extracted JSON";
        const jsonObject = JSON.parse(jsonString);

        parsingStage = "validating schema";
        parsedResponse = aiResponseSchema.parse(jsonObject);

        // Get the date from the first (and only) key in the parsed response
        const intakeDate = Object.keys(parsedResponse)[0];
        const intakeData = parsedResponse[intakeDate];

        // Check if the key (userName) already exists in the cache
        const existingData = await c.env.cache.get(userName);

        console.log("existingData:", existingData);

        if (existingData) {
          try {
            // If the key exists, parse the existing data
            const parsedExistingData: AiResponse = JSON.parse(existingData);

            // Check if the intake date exists in the parsed data
            if (parsedExistingData[intakeDate]) {
              const existingFoods = parsedExistingData[intakeDate].foods;

              console.log("existingFoods:", existingFoods);

              // Function to check if a food item already exists
              const foodExists = (newFood: z.infer<typeof foodItemSchema>) =>
                existingFoods.some((existingFood: z.infer<typeof foodItemSchema>) =>
                  ["name", "amount", "calories", "protein", "carbs", "fat"].every(
                    (prop) => existingFood[prop as keyof typeof existingFood] === newFood[prop as keyof typeof newFood]
                  )
                );

              // Filter out duplicates and add only new food items
              const newFoods = intakeData.foods.filter((food) => !foodExists(food));
              const updatedFoods = [...existingFoods, ...newFoods];

              // Update the cache with the merged foods array
              await c.env.cache.put(
                userName,
                JSON.stringify({
                  ...parsedExistingData,
                  [intakeDate]: {
                    foods: updatedFoods,
                    summary: intakeData.summary,
                  },
                })
              );
              console.log("Updated existing entry in KV", userName);

              // Update the parsedResponse with the merged foods array
              parsedResponse[intakeDate].foods = updatedFoods;
            } else {
              // If the intake date doesn't exist, add it to the existing data
              await c.env.cache.put(
                userName,
                JSON.stringify({
                  ...parsedExistingData,
                  [intakeDate]: intakeData,
                })
              );
              console.log("Added new date to existing entry in KV", userName);
            }
          } catch (parseError) {
            console.error("Error parsing existing data:", parseError);
            // If parsing fails, treat it as if there's no existing data
            await c.env.cache.put(userName, JSON.stringify(parsedResponse));
            console.log("Replaced corrupted data with new entry in KV", userName);
          }
        } else {
          // If the key doesn't exist, save the new data as before
          await c.env.cache.put(userName, JSON.stringify(parsedResponse));
          console.log("Saved new entry to KV", userName);
        }

        // Recalculate the summary based on all foods for the day
        const recalculatedSummary = parsedResponse[intakeDate].foods.reduce(
          (acc, food) => ({
            calories: (parseFloat(acc.calories) + parseFloat(food.calories)).toString(),
            protein: (parseFloat(acc.protein) + parseFloat(food.protein)).toString(),
            carbs: (parseFloat(acc.carbs) + parseFloat(food.carbs)).toString(),
            fat: (parseFloat(acc.fat) + parseFloat(food.fat)).toString(),
          }),
          { calories: "0", protein: "0", carbs: "0", fat: "0" }
        );

        parsedResponse[intakeDate].summary = recalculatedSummary;
      } catch (error: unknown) {
        console.error("Error parsing AI response:", error);
        console.error("Problematic responseText:", responseText);
        if (error instanceof z.ZodError) {
          console.error("Zod validation errors:", JSON.stringify(error.errors, null, 2));
        }
        if (error instanceof Error) {
          console.error("Error stack:", error.stack);
          throw new Error(`Failed to parse AI response: ${error.message}`);
        } else {
          throw new Error("Failed to parse AI response: Unknown error");
        }
      }

      console.log("Successfully parsed and validated AI response");
      console.log("Parsed response:", JSON.stringify(parsedResponse, null, 2));

      return c.json(parsedResponse);
    } catch (error) {
      console.error("Error posting intake:", error);
      throw c.json({ error: "Failed to post intake" }, 500);
    }
  })
  .get("/summary/:userName", zValidator("param", z.object({ userName: z.string().min(1) })), async (c) => {
    try {
      const { userName } = c.req.valid("param");

      let allIntakes: AiResponse = {};

      let overallSummary = { calories: 0, protein: 0, carbs: 0, fat: 0 };
      let daysCount = 0;

      const currentDate = new Date();
      const currentYear = currentDate.getUTCFullYear();
      const currentMonth = currentDate.getUTCMonth();

      const value = await c.env.cache.get(userName);
      if (value) {
        const parsedValue: AiResponse = JSON.parse(value);

        // Filter and process intakes for the current month
        for (const [date, intakeData] of Object.entries(parsedValue)) {
          const intakeDate = new Date(date);
          if (intakeDate.getUTCFullYear() === currentYear && intakeDate.getUTCMonth() === currentMonth) {
            allIntakes[date] = intakeData;
            daysCount++;

            // Calculate daily summary and add to overall summary
            const dailySummary = intakeData.foods.reduce(
              (acc, food) => ({
                calories: acc.calories + parseFloat(food.calories),
                protein: acc.protein + parseFloat(food.protein),
                carbs: acc.carbs + parseFloat(food.carbs),
                fat: acc.fat + parseFloat(food.fat),
              }),
              { calories: 0, protein: 0, carbs: 0, fat: 0 }
            );

            // Add to overall summary
            overallSummary.calories += dailySummary.calories;
            overallSummary.protein += dailySummary.protein;
            overallSummary.carbs += dailySummary.carbs;
            overallSummary.fat += dailySummary.fat;
          }
        }
      }

      // Calculate averages for the overall summary
      const averageSummary = {
        calories: daysCount > 0 ? (overallSummary.calories / daysCount).toFixed(2) : "0",
        protein: daysCount > 0 ? (overallSummary.protein / daysCount).toFixed(2) : "0",
        carbs: daysCount > 0 ? (overallSummary.carbs / daysCount).toFixed(2) : "0",
        fat: daysCount > 0 ? (overallSummary.fat / daysCount).toFixed(2) : "0",
      };

      // Prepare the response with sorted daily intakes
      const response = {
        month: `${currentYear}-${(currentMonth + 1).toString().padStart(2, "0")}`,
        dailyIntakes: Object.entries(allIntakes)
          .map(([date, data]) => ({
            date,
            foods: data.foods,
            summary: data.summary,
          }))
          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
        overallSummary: {
          total: {
            calories: overallSummary.calories.toFixed(2),
            protein: overallSummary.protein.toFixed(2),
            carbs: overallSummary.carbs.toFixed(2),
            fat: overallSummary.fat.toFixed(2),
          },
          average: averageSummary,
        },
      };

      return c.json(response);
    } catch (error) {
      console.error("Error getting summary:", error);
      return c.json({ error: "Failed to get summary" }, 500);
    }
  })
  .get("/daily_intake/:userName", zValidator("param", z.object({ userName: z.string().min(1) })), async (c) => {
    try {
      const { userName } = c.req.valid("param");

      let dailyIntakes: {
        date: string;
        foods: z.infer<typeof foodItemSchema>[];
        summary: z.infer<typeof summarySchema>;
      }[] = [];

      const cacheValue = await c.env.cache.get(userName);
      console.log("Cache value for user:", userName, cacheValue);

      if (cacheValue) {
        const parsedValue: AiResponse = JSON.parse(cacheValue);
        console.log("Parsed cache value:", parsedValue);

        const today = new Date();
        const todayDayOfWeek = today.getDay();

        for (const [date, intakeData] of Object.entries(parsedValue)) {
          const intakeDate = new Date(date);

          console.log("Comparing days of week:", intakeDate.getDay(), todayDayOfWeek);

          if (intakeDate.getDay() === todayDayOfWeek) {
            console.log("Found matching day of week:", date);
            const foodsWithMealType = intakeData.foods.map((food: FoodItem) => ({
              ...food,
              mealType: getMealType(intakeDate.toISOString()),
            }));

            dailyIntakes.push({
              date: date, // Keep the original date
              foods: foodsWithMealType,
              summary: intakeData.summary,
            });
          }
        }

        // Sort dailyIntakes by date and time in descending order (latest first)
        dailyIntakes.sort((a, b) => {
          const dateA = new Date(a.date).getTime();
          const dateB = new Date(b.date).getTime();
          return dateB - dateA;
        });
      }

      if (dailyIntakes.length > 0) {
        console.log("Returning sorted daily intakes:", dailyIntakes);
        return c.json(dailyIntakes);
      } else {
        console.log("No intakes found for today's day of the week");
        return c.json({ message: `No intakes found for today's day of the week` }, 404);
      }
    } catch (error) {
      console.error("Error getting daily intakes:", error);
      return c.json({ error: "Failed to get daily intakes" }, 500);
    }
  })
  .post("/resetkv/:userName", zValidator("param", z.object({ userName: z.string().min(1) })), async (c) => {
    const { userName } = c.req.valid("param");
    await c.env.cache.delete(userName);
    return c.json({ success: true, message: `${userName} data deleted` });
  })
  .get("/keys", async (c) => {
    const cacheKeys = await c.env.cache.list();
    return c.json(cacheKeys.keys);
  })
  .post("/testkv", async (c) => {
    try {
      const key = new Date().toISOString();
      const value = Math.random().toString();
      await c.env.cache.put(key, value);
      const lists = await c.env.cache.list();
      console.log(`Successfully saved to KV. Key: ${key}, Value: ${value}`);
      console.log("lists", JSON.stringify(lists.keys, null, 2));
      return c.json({ success: true, message: "Data saved to KV successfully" });
    } catch (error) {
      console.error("Error saving to KV:", error);
      return c.json({ success: false, message: "Failed to save data to KV" }, 500);
    }
  })
  .delete(
    "/intake/:userName/:date",
    zValidator(
      "param",
      z.object({
        userName: z.string().min(1),
        date: z.string().min(1),
      })
    ),
    async (c) => {
      try {
        const { userName, date } = c.req.valid("param");

        // Get existing data
        const existingData = await c.env.cache.get(userName);
        if (!existingData) {
          return c.json({ message: "No data found for user" }, 404);
        }

        const parsedData: AiResponse = JSON.parse(existingData);

        // Check if the date exists
        if (!parsedData[date]) {
          return c.json({ message: "No data found for specified date" }, 404);
        }

        // Remove the specified date's data
        delete parsedData[date];

        // If there's still other data, update the KV store
        if (Object.keys(parsedData).length > 0) {
          await c.env.cache.put(userName, JSON.stringify(parsedData));
        } else {
          // If no data left, delete the entire user entry
          await c.env.cache.delete(userName);
        }

        return c.json({
          success: true,
          message: `Data for ${userName} on ${date} deleted successfully`,
        });
      } catch (error) {
        console.error("Error deleting intake:", error);
        return c.json({ error: "Failed to delete intake" }, 500);
      }
    }
  )
  .get("/leaderboard", async (c) => {
    try {
      // Get current date in ISO format
      const currentDate = new Date().toISOString();
      const cacheKeys = await c.env.cache.list();

      // Array to store user calorie data
      const userCalories: Array<{
        username: string;
        calories: number;
      }> = [];

      const maskUsername = (username: string) => {
        if (username.length <= 4) {
          return "*".repeat(username.length);
        }
        return username.slice(0, -4) + "****";
      };

      // Process each user's data
      for (const { name: userName } of cacheKeys.keys) {
        const value = await c.env.cache.get(userName);
        if (value) {
          const parsedValue: AiResponse = JSON.parse(value);
          let totalCalories = 0;

          // Find all intakes for today and sum up calories
          for (const [date, intakeData] of Object.entries(parsedValue)) {
            const intakeDate = new Date(date);
            const today = new Date(currentDate);

            if (
              intakeDate.getUTCFullYear() === today.getUTCFullYear() &&
              intakeDate.getUTCMonth() === today.getUTCMonth() &&
              intakeDate.getUTCDate() === today.getUTCDate()
            ) {
              // Sum up calories from all foods for this entry
              const entryCalories = intakeData.foods.reduce((sum, food) => sum + parseFloat(food.calories), 0);
              totalCalories += entryCalories;
            }
          }

          // Only add to leaderboard if user has calories for today
          if (totalCalories > 0) {
            userCalories.push({
              username: maskUsername(userName),
              calories: totalCalories,
            });
          }
        }
      }

      // Sort by calories in descending order and take top 5
      const leaderboard = userCalories
        .sort((a, b) => b.calories - a.calories)
        .slice(0, 5)
        .map((entry, index) => ({
          rank: index + 1,
          username: entry.username,
          calories: entry.calories.toFixed(1),
        }));

      return c.json(leaderboard);
    } catch (error) {
      console.error("Error getting leaderboard:", error);
      return c.json({ error: "Failed to get leaderboard" }, 500);
    }
  })
  .get("/socket", async (c) => {
    if (!wsHandler) {
      wsHandler = new WebSocketHandler(c.env.cache);
    }
    return wsHandler.fetch(c.req.raw);
  })
  .post("/broadcast", async (c) => {
    if (!wsHandler) {
      wsHandler = new WebSocketHandler(c.env.cache);
    }
    return wsHandler.fetch(c.req.raw);
  });
// .post("/notify", async (c) => {
//   const { clientId, message } = await c.req.json();

//   // const sent = sendToClient(clientId, {
//   //   type: "notification",
//   //   message,
//   // });

//   if (sent) {
//     return c.json({ success: true });
//   } else {
//     return c.json({ success: false, error: "Client not found" }, 404);
//   }
// });

export default app;
