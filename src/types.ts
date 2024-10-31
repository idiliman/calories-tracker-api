import { z } from "zod";

export interface LeaderboardUser {
  id: string;
  username: string;
  score: number;
  lastUpdated: Date;
}

export const LeaderboardScoreSchema = z.object({
  username: z.string().min(1),
  score: z.number().min(0),
});

export const promptSchema = z.object({
  userName: z.string().min(1),
  prompt: z.string().min(1),
});

export const foodItemSchema = z.object({
  name: z.string(),
  calories: z.string(),
  protein: z.string(),
  carbs: z.string(),
  fat: z.string(),
  amount: z.string(),
  mealType: z.string().optional(),
});

export const summarySchema = z.object({
  calories: z.string(),
  protein: z.string(),
  carbs: z.string(),
  fat: z.string(),
});

export const aiResponseSchema = z.record(
  z.string(),
  z.object({
    foods: z.array(foodItemSchema),
    summary: summarySchema,
  })
);

export type AiResponse = {
  [date: string]: {
    foods: z.infer<typeof foodItemSchema>[];
    summary: z.infer<typeof summarySchema>;
  };
};

export type Prompt = z.infer<typeof promptSchema>;
export type Summary = z.infer<typeof summarySchema>;
export type FoodItem = z.infer<typeof foodItemSchema>;
export type DailyIntake = Pick<AiResponse, "date" | "foods">;
