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
