import { geocodeCity, getFxRates, getUpcomingHolidays, getWeather } from "@/lib/external";
import { DashboardQuery } from "@/lib/schemas";
import { type NextRequest, NextResponse } from "next/server";

// Parallelizable: weather, FX and holidays don't depend on each other, but the default path
// awaits them one after another. ?parallel=1 runs them with Promise.all.
export async function GET(req: NextRequest) {
  const parsed = DashboardQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ issues: parsed.error.issues }, { status: 422 });
  }
  const { city, currency, parallel } = parsed.data;

  // Weather and holidays need the location first; that dependency is real.
  const place = await geocodeCity(city);

  let weather: Awaited<ReturnType<typeof getWeather>>;
  let fx: Awaited<ReturnType<typeof getFxRates>>;
  let holidays: Awaited<ReturnType<typeof getUpcomingHolidays>>;
  if (parallel === "1") {
    [weather, fx, holidays] = await Promise.all([
      getWeather(place.latitude, place.longitude),
      getFxRates("USD", [currency]),
      getUpcomingHolidays(place.country_code),
    ]);
  } else {
    weather = await getWeather(place.latitude, place.longitude);
    fx = await getFxRates("USD", [currency]);
    holidays = await getUpcomingHolidays(place.country_code);
  }

  return NextResponse.json({
    strategy: parallel === "1" ? "parallel" : "sequential",
    place: { name: place.name, country: place.country, timezone: place.timezone },
    weather,
    fx,
    holidays,
  });
}
