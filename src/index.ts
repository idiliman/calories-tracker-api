import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

type Env = {
  AI: Ai;
  cache: KVNamespace;
};

const app = new Hono<{ Bindings: Env }>();

const schema = z.object({
  prompt: z.string(),
});

const foodItemSchema = z.object({
  name: z.string(),
  calories: z.string(),
  protein: z.string(),
  carbs: z.string(),
  fat: z.string(),
  amount: z.string(),
});

const summarySchema = z.object({
  calories: z.string(),
  protein: z.string(),
  carbs: z.string(),
  fat: z.string(),
});

const aiResponseSchema = z.object({
  date: z.string(),
  foods: z.array(foodItemSchema),
  summary: summarySchema,
});

type DailyIntake = Pick<z.infer<typeof aiResponseSchema>, "date" | "foods">;

app
  .post("/", zValidator("json", schema), async (c) => {
    const { prompt } = c.req.valid("json");

    let prevIntake: DailyIntake[] = [];
    const cacheKeys = await c.env.cache.list();

    for (const key of cacheKeys.keys) {
      const value = await c.env.cache.get(key.name);
      if (value) {
        prevIntake.push({
          date: key.name,
          foods: JSON.parse(value),
        });
      }
    }

    console.log(
      "prevIntake:",
      prevIntake.map((item) => ({
        ...item,
        foods: JSON.stringify(item.foods, null, 2),
      }))
    );

    const currentDate = new Date().toISOString();

    const aiResponse = await c.env.AI.run("@cf/meta/llama-2-7b-chat-int8", {
      messages: [
        {
          role: "system",
          content: `\
    Current date is: ${currentDate}

    You are a helpful assistant in nutrient analysis who can help users analyze their nutrient intake.

    User will give you a list of foods they ate.

    You will act like API response, return the following data only in JSON format :
    {
      date: string;
      foods: Array<{
        name: string;
        calories: string;
        protein: string;
        carbs: string;
        fat: string;
        amount: string;
      }>;
      summary: {
        calories: string;
        protein: string;
        carbs: string;
        fat: string;
      };
    }

    Make sure to keep track of the date in ISO format.

    Previous information of the user intake:${JSON.stringify(prevIntake)}.
    `,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      raw: true,
    });

    let responseText: string = "";
    let parsedResponse: z.infer<typeof aiResponseSchema> = {
      date: "",
      foods: [],
      summary: { calories: "", protein: "", carbs: "", fat: "" },
    };

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

    try {
      // Use a regular expression to find the JSON object in the response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON object found in the response");
      }

      const jsonString = jsonMatch[0];
      const jsonObject = JSON.parse(jsonString);
      parsedResponse = aiResponseSchema.parse(jsonObject);

      // Check if the key (date) already exists in the cache
      const existingData = await c.env.cache.get(parsedResponse.date);

      if (existingData) {
        // If the key exists, parse the existing data
        const existingFoods = JSON.parse(existingData);

        // Function to check if a food item already exists
        const foodExists = (newFood: z.infer<typeof foodItemSchema>) =>
          existingFoods.some((existingFood: z.infer<typeof foodItemSchema>) =>
            ["name", "amount", "calories", "protein", "carbs", "fat"].every(
              (prop) => existingFood[prop as keyof typeof existingFood] === newFood[prop as keyof typeof newFood]
            )
          );

        // Filter out duplicates and add only new food items
        const newFoods = parsedResponse.foods.filter((food) => !foodExists(food));
        const updatedFoods = [...existingFoods, ...newFoods];

        // Update the cache with the merged foods array
        await c.env.cache.put(parsedResponse.date, JSON.stringify(updatedFoods));
        console.log("Updated existing entry in KV", parsedResponse.date);

        // Update the parsedResponse with the merged foods array
        parsedResponse.foods = updatedFoods;
      } else {
        // If the key doesn't exist, save the new data as before
        await c.env.cache.put(parsedResponse.date, JSON.stringify(parsedResponse.foods));
        console.log("Saved new entry to KV", parsedResponse.date);
      }

      // Recalculate the summary based on all foods for the day
      const recalculatedSummary = parsedResponse.foods.reduce(
        (acc, food) => ({
          calories: (parseFloat(acc.calories) + parseFloat(food.calories)).toString(),
          protein: (parseFloat(acc.protein) + parseFloat(food.protein)).toString(),
          carbs: (parseFloat(acc.carbs) + parseFloat(food.carbs)).toString(),
          fat: (parseFloat(acc.fat) + parseFloat(food.fat)).toString(),
        }),
        { calories: "0", protein: "0", carbs: "0", fat: "0" }
      );

      parsedResponse.summary = recalculatedSummary;
    } catch (error) {
      console.error("Error parsing AI response:", error);
      console.error("Problematic responseText:", responseText);
      throw new Error("Failed to parse AI response");
    }

    return c.json(parsedResponse);
  })
  .get("/summary", async (c) => {
    let allIntakes: z.infer<typeof aiResponseSchema>[] = [];
    const cacheKeys = await c.env.cache.list();
    let overallSummary = { calories: 0, protein: 0, carbs: 0, fat: 0 };

    for (const key of cacheKeys.keys) {
      const value = await c.env.cache.get(key.name);
      if (value) {
        const foods: z.infer<typeof foodItemSchema>[] = JSON.parse(value);
        const dailySummary = foods.reduce(
          (acc, food) => ({
            calories: acc.calories + parseFloat(food.calories),
            protein: acc.protein + parseFloat(food.protein),
            carbs: acc.carbs + parseFloat(food.carbs),
            fat: acc.fat + parseFloat(food.fat),
          }),
          { calories: 0, protein: 0, carbs: 0, fat: 0 }
        );

        allIntakes.push({
          date: key.name,
          foods: foods,
          summary: {
            calories: dailySummary.calories.toFixed(2),
            protein: dailySummary.protein.toFixed(2),
            carbs: dailySummary.carbs.toFixed(2),
            fat: dailySummary.fat.toFixed(2),
          },
        });

        // Add to overall summary
        overallSummary.calories += dailySummary.calories;
        overallSummary.protein += dailySummary.protein;
        overallSummary.carbs += dailySummary.carbs;
        overallSummary.fat += dailySummary.fat;
      }
    }

    // Calculate averages for the overall summary
    const daysCount = allIntakes.length;
    const averageSummary = {
      calories: (overallSummary.calories / daysCount).toFixed(2),
      protein: (overallSummary.protein / daysCount).toFixed(2),
      carbs: (overallSummary.carbs / daysCount).toFixed(2),
      fat: (overallSummary.fat / daysCount).toFixed(2),
    };

    return c.json({
      dailyIntakes: allIntakes,
      overallSummary: {
        total: {
          calories: overallSummary.calories.toFixed(2),
          protein: overallSummary.protein.toFixed(2),
          carbs: overallSummary.carbs.toFixed(2),
          fat: overallSummary.fat.toFixed(2),
        },
        average: averageSummary,
      },
    });
  })
  .get("/resetkv", async (c) => {
    const cacheKeys = await c.env.cache.list();
    for (const key of cacheKeys.keys) {
      await c.env.cache.delete(key.name);
    }
    return c.json({ success: true, message: "All data reset" });
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
