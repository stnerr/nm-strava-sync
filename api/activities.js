// api/activities.js – Fetch and transform Strava activities
// Updated June 2026:
//   - sport_type preferred over deprecated type field
//   - Authorization token sent in header (required from June 2027, good practice now)
//   - New base URL https://www.api-v3.strava.com available from Jan 4 2027;
//     using current URL until then

// NOTE: Switch to https://www.api-v3.strava.com after Jan 4 2027
const STRAVA_API = "https://www.strava.com";

async function refreshIfNeeded(access_token, refresh_token, expires_at) {
  const now = Math.floor(Date.now() / 1000);
  if (expires_at && now < expires_at - 300) {
    return { access_token, refresh_token, expires_at };
  }
  // Token expired – refresh via OAuth endpoint (stays on www.strava.com)
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id:     process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token,
      grant_type:    "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }
  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    data.expires_at,
  };
}

// Maps Strava sport_type (preferred) with fallback to type (deprecated)
function stravaTypeToLocal(sportType) {
  const runs = ["Run","TrailRun","VirtualRun","Hike","Walk"];
  const bikes = ["Ride","VirtualRide","EBikeRide","MountainBikeRide","GravelRide","Velomobile"];
  const swim = ["Swim"];
  const strength = ["WeightTraining","Crossfit","Workout","Yoga","Pilates","Elliptical","RockClimbing","Snowboard","AlpineSki"];
  if (runs.includes(sportType)) return "run";
  if (bikes.includes(sportType)) return "bike";
  if (swim.includes(sportType)) return "alt";   // swim maps to alternativt
  if (strength.includes(sportType)) return "strength";
  return "alt";
}

function detectRunSubtype(activity) {
  // Strava workout_type: 0=default, 1=race, 2=long run, 3=workout
  if (activity.workout_type === 1) return "race";
  if (activity.workout_type === 2) return "long";
  if (activity.workout_type === 3) return "intervals";
  const avgHr = activity.average_heartrate;
  const paceSecPerKm = activity.moving_time / (activity.distance / 1000);
  const paceMinKm = paceSecPerKm / 60;
  if (avgHr > 165 || paceMinKm < 4.5) return "intervals";
  if (activity.distance > 18000) return "long";
  return "easy";
}

function formatPace(activity) {
  if (!activity.distance || !activity.moving_time) return "";
  const secPerKm = activity.moving_time / (activity.distance / 1000);
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function toDateStr(isoStr) {
  const d = new Date(isoStr);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { access_token, refresh_token, expires_at, after } = req.query;

  if (!access_token || !refresh_token) {
    return res.status(401).json({ error: "Missing tokens" });
  }

  try {
    // Refresh token if needed
    const tokens = await refreshIfNeeded(
      access_token,
      refresh_token,
      parseInt(expires_at) || 0
    );

    // Fetch activities – use new base URL, token in Authorization header
    const afterTs = after
      ? parseInt(after)
      : Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 90; // default 90 days

    const stravaRes = await fetch(
      `${STRAVA_API}/api/v3/athlete/activities?after=${afterTs}&per_page=50`,
      {
        headers: {
          // Token must be in header (not form params) – required from June 2027
          Authorization: `Bearer ${tokens.access_token}`,
        },
      }
    );

    if (!stravaRes.ok) {
      const body = await stravaRes.text();
      console.error("Strava API error:", stravaRes.status, body);
      return res.status(stravaRes.status).json({ error: "Strava API error", detail: body });
    }

    const activities = await stravaRes.json();

    // Transform to app format
    // Use sport_type (new preferred field) with fallback to type (deprecated)
    const sessions = activities
      .filter(a => {
        const st = a.sport_type || a.type;
        const localType = stravaTypeToLocal(st);
        return ["run","bike","alt","strength"].includes(localType);
      })
      .map(a => {
        const sportType = a.sport_type || a.type; // prefer sport_type
        const baseType = stravaTypeToLocal(sportType);
        const isRun = baseType === "run";
        const type = isRun ? detectRunSubtype(a) : baseType;
        const isSwim = baseType === "alt" && sportType === "Swim";
        const distKm = a.distance ? (a.distance / 1000) : 0;

        // Swim pace: min/100m
        let swimPace = "";
        if (isSwim && a.distance && a.moving_time) {
          const secPer100m = a.moving_time / (a.distance / 100);
          const m = Math.floor(secPer100m / 60);
          const s = Math.round(secPer100m % 60);
          swimPace = `${m}:${String(s).padStart(2,"0")}`;
        }

        // Elevation gain
        const elevGain = a.total_elevation_gain ? Math.round(a.total_elevation_gain) : "";

        // Grade-adjusted pace for runs
        let gap = "";
        if (isRun && a.total_elevation_gain && distKm > 0 && a.moving_time) {
          const rawPaceMin = (a.moving_time / 60) / distKm;
          const grade = (a.total_elevation_gain / distKm) / 10; // % grade per km
          const adjFactor = 1 - (grade * 0.033);
          const adjPace = rawPaceMin * adjFactor;
          const gMin = Math.floor(adjPace);
          const gSec = Math.round((adjPace % 1) * 60);
          gap = `${gMin}:${String(gSec).padStart(2,"0")}`;
        }

        // Clean up auto-generated Strava activity names
        const autoNames = new Set(["Morning Run","Afternoon Run","Evening Run","Lunch Run","Night Run","Morning Ride","Afternoon Ride","Evening Ride","Lunch Ride","Morning Walk","Afternoon Walk","Morning Swim","Afternoon Swim","Workout"]);
        const title = autoNames.has(a.name) ? "" : a.name;

        return {
          id:        `strava_${a.id}`,
          stravaId:  a.id,
          date:      toDateStr(a.start_date_local),
          type,
          title,
          km:        distKm > 0 ? distKm.toFixed(2) : "",
          totalTime: a.moving_time ? Math.round(a.moving_time / 60) : "",
          avgPace:   isRun ? formatPace(a) : "",
          gap,
          swimPace,
          avgHr:     a.average_heartrate ? Math.round(a.average_heartrate) : "",
          maxHr:     a.max_heartrate     ? Math.round(a.max_heartrate)     : "",
          temp:      a.average_temp      || "",
          elevGain,
          humidity:  "",
          rpe:       "",
          notes:     "",
          intervals: [],
          stravaUrl: `https://www.strava.com/activities/${a.id}`,
        };
      });

    return res.status(200).json({
      sessions,
      tokens: {
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at:    tokens.expires_at,
      },
    });
  } catch (err) {
    console.error("Activities error:", err);
    return res.status(500).json({ error: "Internal error", detail: err.message });
  }
}
