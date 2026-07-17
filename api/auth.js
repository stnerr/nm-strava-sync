// api/auth.js – Strava OAuth callback
// Updated June 2026: sport_type preferred over type

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.redirect("/?error=strava_denied");
  }

  if (!code) {
    // Step 1: redirect to Strava login
    const params = new URLSearchParams({
      client_id:       process.env.STRAVA_CLIENT_ID,
      redirect_uri:    `${process.env.BASE_URL}/api/auth`,
      response_type:   "code",
      approval_prompt: "auto",
      scope:           "activity:read_all",
    });
    return res.redirect(`https://www.strava.com/oauth/authorize?${params}`);
  }

  // Step 2: exchange code for tokens
  // Note: token endpoint stays on www.strava.com (OAuth host unchanged)
  try {
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id:     process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type:    "authorization_code",
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      console.error("Token exchange failed:", tokens);
      return res.redirect("/?error=token_exchange_failed");
    }

    // Redirect back to app with tokens in URL fragment (never stored server-side)
    const fragment = new URLSearchParams({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    tokens.expires_at,
      athlete_id:    tokens.athlete?.id || "",
    });

    return res.redirect(`/?strava_auth=1#${fragment}`);
  } catch (err) {
    console.error("Auth error:", err);
    return res.redirect("/?error=auth_failed");
  }
}
