// Vercel entry point: the whole CMS (Express) runs as one serverless function. Every address is sent here by
// vercel.json; locally the CMS still starts with `npm run dev`.
export { default } from "../src/server.js";
