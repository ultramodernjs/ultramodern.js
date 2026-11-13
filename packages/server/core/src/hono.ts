// === Export Hono.js Core Types and APIs ===

// Core types from Hono
export type {
  Context,
  HonoRequest,
  MiddlewareHandler,
  MiddlewareHandler as Middleware,
  Next,
} from 'hono';

// Hono utilities
export { deleteCookie, getCookie, setCookie } from 'hono/cookie';

export { languageDetector } from 'hono/language';
