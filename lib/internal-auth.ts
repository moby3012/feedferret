export function validateInternalApiKey(request: Request): boolean {
  const key = process.env.INTERNAL_API_KEY;
  if (!key) return false;

  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  const token = authHeader.slice(7).trim();
  return token === key;
}
