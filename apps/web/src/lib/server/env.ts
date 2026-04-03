import { env } from "$env/dynamic/private";

export const API_TARGET = env["API_URL"] ?? "http://localhost:3001";
