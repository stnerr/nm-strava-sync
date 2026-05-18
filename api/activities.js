// api/activities.js – Fetch and transform Strava activities
// Vercel serverless function

async function refreshIfNeeded(access_token, refresh_token, expires_at) {
  const now = Math.floor(Date.now() / 1000);
  if (expires_at && now < expires_at - 300) {
    return { access_token, refresh_token, expires_at };
  }
  // Token expired – refresh
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
  };
}

function stravaTypeToLocal(type) {
  if (["Run", "TrailRun", "VirtualRun"].includes(type)) {
    return "easy"; // will be overridden by speed/HR analysis below
  }
  if (["Ride", "VirtualRide", "EBikeRide"].includes(type)) return "bike";
  if (["WeightTraining", "Crossfit", "Workout"].includes(type)) return "strength";
  if (["Walk", "Hike"].includes(type)) return "easy";
  return "easy";
}

function detectRunType(activity) {
  // Heuristic: if avg HR > 85% of estimated max (220-age, default 185)
  // or pace < 4:30/km → intervals candidate
  const avgHr = activity.average_heartrate;
  const paceSecPerKm = activity.moving_time / (activity.distance / 1000);
  const paceMinKm = paceSecPerKm / 60;

  if (activity.workout_type === 3) return "intervals"; // Strava workout type 3 = race
  if (activity.workout_type === 2) return "long";      // Strava type 2 = long run
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
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default async function handler(req, res) {
  // CORS for the Claude artifact origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

    // Fetch activities from Strava
    const afterTs = after ? parseInt(after) : Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 90; // default 90 days
    const stravaRes = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${afterTs}&per_page=50`,
      { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    );

    if (!stravaRes.ok) {
      return res.status(stravaRes.status).json({ error: "Strava API error" });
    }

    const activities = await stravaRes.json();

    // Transform to app format
    const sessions = activities
      .filter(a => ["Run","TrailRun","VirtualRun","Ride","VirtualRide","WeightTraining","Walk"].includes(a.type))
      .map(a => {
        const isRun = ["Run","TrailRun","VirtualRun"].includes(a.type);
        const type = isRun ? detectRunType(a) : stravaTypeToLocal(a.type);
        return {
          id: `strava_${a.id}`,
          stravaId: a.id,
          date: toDateStr(a.start_date_local),
          type,
          km: a.distance ? (a.distance / 1000).toFixed(2) : "",
          totalTime: a.moving_time ? Math.round(a.moving_time / 60) : "",
          avgPace: isRun ? formatPace(a) : "",
          avgHr: a.average_heartrate ? Math.round(a.average_heartrate) : "",
          maxHr: a.max_heartrate ? Math.round(a.max_heartrate) : "",
          temp: a.average_temp || "",
          humidity: "",
          rpe: "",
          notes: a.name !== "Morning Run" && a.name !== "Afternoon Run" ? a.name : "",
          intervals: [],
          stravaUrl: `https://www.strava.com/activities/${a.id}`,
        };
      });

    return res.status(200).json({
      sessions,
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at,
      },
    });
  } catch (err) {
    console.error("Activities error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
