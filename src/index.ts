import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getCurrentDateTime, getMealType } from "./utils";
import { parseISO, isToday } from "date-fns";

type Env = {
  AI: Ai;
  cache: KVNamespace;
};

const app = new Hono<{ Bindings: Env }>();

const promptSchema = z.object({
  userName: z.string().min(1),
  prompt: z.string().min(1),
});

const foodItemSchema = z.object({
  name: z.string(),
  calories: z.string(),
  protein: z.string(),
  carbs: z.string(),
  fat: z.string(),
  amount: z.string(),
  mealType: z.string().optional(),
});

const summarySchema = z.object({
  calories: z.string(),
  protein: z.string(),
  carbs: z.string(),
  fat: z.string(),
});

const aiResponseSchema = z.record(
  z.string(),
  z.object({
    foods: z.array(foodItemSchema),
    summary: summarySchema,
  })
);

type AiResponse = {
  [date: string]: {
    foods: z.infer<typeof foodItemSchema>[];
    summary: z.infer<typeof summarySchema>;
  };
};
type Prompt = z.infer<typeof promptSchema>;
type Summary = z.infer<typeof summarySchema>;
type FoodItem = z.infer<typeof foodItemSchema>;
type DailyIntake = Pick<AiResponse, "date" | "foods">;

app
  .post("/intake", zValidator("json", promptSchema), async (c) => {
    try {
      const { userName, prompt } = c.req.valid("json");
      console.log(".post ~ prompt:", prompt);
      console.log(".post ~ userName:", userName);

      // Get previous intake
      let prevIntake: DailyIntake[] = [];
      const cacheValue = await c.env.cache.get(userName);
      if (cacheValue) {
        const cachedValue: AiResponse = JSON.parse(cacheValue);
        prevIntake.push({
          date: cachedValue.date,
          foods: cachedValue.foods,
        });
      }

      const currentDate = new Date().toISOString();

      const aiResponse = await c.env.AI.run("@cf/meta/llama-2-7b-chat-int8", {
        messages: [
          {
            role: "system",
            content: `\
    You are a helpful assistant in nutrient analysis who can help users analyze their foods. 
    
    User will give you a list of foods they eat. When formulating your response take carefully consideration of this key details : 
    1) The foods most likely will be asian cuisine region focused on Malaysian, Singapore, Thailand.
    2) Make sure to keep track of the date ${currentDate} in Malaysia time zone in ISO format.
    3) If the date or when is not specified, use current date ${currentDate}.
    4) You will act like API response, when answering return the following data only in JSON format, for nutrient details dont include the unit :
    {
      ${currentDate}: {
        foods: Array<{
        name: string;
        calories: string;
        protein: string;
        carbs: string;
        fat: string;
        amount: string;
      }>,
      summary: {
        calories: string;
        protein: string;
        carbs: string;
        fat: string;
      }
    }
  }
    5) If the intake date is not ${currentDate}, save the date in Malaysia time zone in ISO format without time.
    6) Previous information of the user intake:${JSON.stringify(prevIntake)}.`,
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        raw: true,
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
  .get("/resetkv", async (c) => {
    const cacheKeys = await c.env.cache.list();
    for (const key of cacheKeys.keys) {
      await c.env.cache.delete(key.name);
    }
    return c.json({ success: true, message: "All data reset" });
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
  });

export default app;
