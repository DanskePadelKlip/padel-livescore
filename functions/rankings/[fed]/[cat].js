// GET /rankings/:fed/:cat — app shell with ranking-page meta injected.
import { SITE, shell, withMeta } from "../../_shared.js";

const REGION = {
  FIP: "FIP world", DK: "Denmark", SE: "Sweden", DE: "Germany", HR: "Croatia",
  EE: "Estonia", GE: "Georgia", HU: "Hungary", UA: "Ukraine", SI: "Slovenia",
  XK: "Kosovo", BA: "Bosnia & Herzegovina", ME: "Montenegro",
};

export async function onRequestGet({ request, params }) {
  const origin = new URL(request.url).origin;
  const fed = String(params.fed || "").toUpperCase();
  const cat = String(params.cat || "").toLowerCase();
  const base = await shell(origin);

  const region = REGION[fed];
  if (!region || (cat !== "men" && cat !== "women")) return base; // unknown → generic

  const g = cat === "women" ? "women's" : "men's";
  const title = `${region} ${g} padel ranking · PadelTicker`;
  const description =
    `The ${region} ${g} padel ranking — live points, positions and weekly movement, updated continuously on PadelTicker.`;
  const canonical = `${SITE}/rankings/${fed}/${cat}`;

  return withMeta(base, { title, description, canonical });
}
