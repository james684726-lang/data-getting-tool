import { createServerFn } from "@tanstack/react-start";

export type BusinessRow = {
  place_id: string;
  name: string;
  maps_url: string | null;
  website: string | null;
  phone: string | null;
  address: string | null;
  rating: number | null;
  reviews: number | null;
  category: string | null;
  latest_post_date: string | null;
  days_since_last_post: number | null;
  posted_last_90_days: "Yes" | "No" | "Unknown";
  facebook: string | null;
  instagram: string | null;
  linkedin: string | null;
  website_tech: string | null;
  email: string | null;
  gps: { lat: number; lng: number } | null;
};

export type SearchPageResult = {
  page: number;
  results: BusinessRow[];
  total_returned: number;
  has_more: boolean;
  error?: string;
};

type SerpApiLocalResult = {
  place_id?: string;
  data_id?: string;
  title?: string;
  address?: string;
  phone?: string;
  website?: string;
  rating?: number;
  reviews?: number;
  type?: string;
  types?: string[];
  gps_coordinates?: { latitude: number; longitude: number };
  place_id_search?: string;
  link?: string;
};

type SerpApiPost = {
  posted_at?: string; // ISO 8601
  posted_at_text?: string;
};

type SerpApiPostsResult = {
  posts?: SerpApiPost[];
  error?: string;
};

async function fetchPostsForDataId(
  dataId: string,
  apiKey: string,
): Promise<SerpApiPostsResult> {
  try {
    const params = new URLSearchParams({
      engine: "google_maps_posts",
      data_id: dataId,
      api_key: apiKey,
    });
    const url = `https://serpapi.com/search.json?${params.toString()}`;
    const resp = await fetch(url);
    const text = await resp.text();
    if (!resp.ok) {
      return { error: `SerpApi Posts ${resp.status}: ${text.slice(0, 300)}` };
    }
    return JSON.parse(text);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Network error" };
  }
}

function toRow(
  r: SerpApiLocalResult,
  postsResult?: SerpApiPostsResult,
): BusinessRow {
  const placeId = r.place_id || r.data_id || "";
  const gps = r.gps_coordinates
    ? { lat: r.gps_coordinates.latitude, lng: r.gps_coordinates.longitude }
    : null;
  const mapsUrl = placeId
    ? `https://www.google.com/maps/place/?q=place_id:${placeId}`
    : gps
      ? `https://www.google.com/maps/search/?api=1&query=${gps.lat},${gps.lng}`
      : null;

  let latestPostDate: string | null = null;
  let daysSinceLastPost: number | null = null;
  let postedLast90Days: "Yes" | "No" | "Unknown" = "Unknown";

  if (postsResult?.posts && postsResult.posts.length > 0) {
    // Sort posts by date descending and pick the latest one
    const sortedPosts = [...postsResult.posts].sort((a, b) => {
      if (!a.posted_at) return 1;
      if (!b.posted_at) return -1;
      return new Date(b.posted_at).getTime() - new Date(a.posted_at).getTime();
    });
    const latestPost = sortedPosts[0];
    latestPostDate = latestPost.posted_at || null;

    if (latestPostDate) {
      const postDate = new Date(latestPostDate);
      const now = new Date();
      daysSinceLastPost = Math.floor(
        (now.getTime() - postDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      postedLast90Days = daysSinceLastPost <= 90 ? "Yes" : "No";
    }
  }

  return {
    place_id: placeId,
    name: r.title || "—",
    maps_url: mapsUrl,
    website: r.website || null,
    phone: r.phone || null,
    address: r.address || null,
    rating: typeof r.rating === "number" ? r.rating : null,
    reviews: typeof r.reviews === "number" ? r.reviews : null,
    category: r.type || (r.types && r.types[0]) || null,
    latest_post_date: latestPostDate,
    days_since_last_post: daysSinceLastPost,
    posted_last_90_days: postedLast90Days,
    facebook: null,
    instagram: null,
    linkedin: null,
    website_tech: null,
    email: null,
    gps,
  };
}

export const searchBusinesses = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      keyword: string;
      location: string;
      start: number;
      radiusMiles: number;
    }) => {
      if (!data.keyword?.trim()) throw new Error("Keyword is required");
      if (!data.location?.trim()) throw new Error("Location is required");
      return {
        keyword: data.keyword.trim(),
        location: data.location.trim(),
        start: Math.max(0, Math.floor(data.start || 0)),
        radiusMiles: [5, 10, 25, 50].includes(data.radiusMiles)
          ? data.radiusMiles
          : 25,
      };
    },
  )
  .handler(async ({ data }): Promise<SearchPageResult> => {
    const key = process.env.SERPAPI_KEY;
    if (!key) {
      return {
        page: Math.floor(data.start / 20),
        results: [],
        total_returned: 0,
        has_more: false,
        error: "SERPAPI_KEY is not configured on the server.",
      };
    }

    // SerpApi google_maps engine returns up to 20 local_results per page.
    // Pagination via `start` (0, 20, 40, ...). Radius via `ll` needs lat,lng,zoom;
    // as a simple approximation, we bias zoom by radius miles.
    // 5mi≈z13, 10mi≈z12, 25mi≈z11, 50mi≈z10.
    const zoomByRadius: Record<number, number> = { 5: 13, 10: 12, 25: 11, 50: 10 };
    const params = new URLSearchParams({
      engine: "google_maps",
      type: "search",
      q: `${data.keyword} in ${data.location}`,
      google_domain: "google.com",
      hl: "en",
      start: String(data.start),
      api_key: key,
    });


    let json: any;
    try {
      const url = `https://serpapi.com/search.json?${params.toString()}`;
      const resp = await fetch(url);
      const text = await resp.text();
      if (!resp.ok) {
        return {
          page: Math.floor(data.start / 20),
          results: [],
          total_returned: 0,
          has_more: false,
          error: `SerpApi ${resp.status}: ${text.slice(0, 300)}`,
        };
      }
      json = JSON.parse(text);
    } catch (e) {
      return {
        page: Math.floor(data.start / 20),
        results: [],
        total_returned: 0,
        has_more: false,
        error: e instanceof Error ? e.message : "Network error",
      };
    }

    if (json.error) {
      return {
        page: Math.floor(data.start / 20),
        results: [],
        total_returned: 0,
        has_more: false,
        error: String(json.error),
      };
    }

    const list: SerpApiLocalResult[] = Array.isArray(json.local_results)
      ? json.local_results
      : Array.isArray(json.place_results)
        ? [json.place_results]
        : [];

    // Fetch posts for each result with a data_id
    const postPromises = list.map((result) =>
      result.data_id ? fetchPostsForDataId(result.data_id, key) : Promise.resolve(undefined),
    );
    const postsResults = await Promise.all(postPromises);

    // Convert to rows
    const rows = list.map((result, index) => toRow(result, postsResults[index]));

    const hasMore = Boolean(
      json.serpapi_pagination?.next || json.serpapi_pagination?.next_link,
    );

    return {
      page: Math.floor(data.start / 20),
      results: rows,
      total_returned: rows.length,
      has_more: hasMore,
    };
  });
