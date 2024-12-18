import { LeaderboardUser } from "./types";

export function getCurrentDateTime(): string {
  return new Date().toISOString();
}

export function getMealType(time: string): string {
  const date = new Date(time);

  // Check if the time ends with T00:00:00.000Z, which indicates no specific time was provided
  if (time.endsWith("T00:00:00.000Z")) {
    return `On ${date.toLocaleDateString("en-US", { weekday: "long" })}`;
  }

  // Convert UTC to Malaysia time (UTC+8)
  const hour = (date.getUTCHours() + 8) % 24;

  if (hour >= 5 && hour < 11) {
    return "Breakfast";
  } else if (hour >= 11 && hour < 14) {
    return "Lunch";
  } else if (hour >= 14 && hour < 17) {
    return "Snack";
  } else if (hour >= 17 && hour < 21) {
    return "Dinner";
  } else {
    return "Late Night Snack";
  }
}

export async function getLeaderboard(store: KVNamespace): Promise<LeaderboardUser[]> {
  const { keys } = await store.list();
  const users: LeaderboardUser[] = [];

  for (const key of keys) {
    const userData = await store.get(key.name);
    if (userData) {
      users.push(JSON.parse(userData));
    }
  }

  return users.sort((a, b) => b.score - a.score).slice(0, 100); // Top 100 users
}
