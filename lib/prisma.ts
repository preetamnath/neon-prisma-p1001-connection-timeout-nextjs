// lib/prisma.ts  – lazy Prisma client + enhanced retry on connection errors

// This file is used to create a singleton instance of the PrismaClient
// This is a best practice to avoid multiple instances of the client in development
// and to ensure that the client is properly disposed of when the app shuts down
// AuthJs Prisma adapter documentation: https://authjs.dev/getting-started/adapters/prisma#configuration
// Prisma ORM documentation to setup Prisma Client: https://www.prisma.io/docs/guides/nextjs#25-set-up-prisma-client 

// Import PrismaClient constructor from Prisma's client library
// After Prisma v6 it is no longer in node modules and instead in a /generated/ folder
import { Prisma, PrismaClient } from '@/lib/generated/prisma';

/* Retry only these transient codes that show up when Neon is still waking */
// Prisma error codes documentation - https://www.prisma.io/docs/orm/reference/error-reference#error-codes
const RETRYABLE_CODES = [
  // --- Connection Errors ---
  'P1001', // Can't reach database server (e.g., DB is starting up)
  'P1002', // The server timed out.
  'P1008', // Operations timed out.
  'P1017', // Server has closed the connection.

  // --- Connection Pool and Transaction Errors ---
  'P2024', // Timed out fetching a new connection from the pool.
] as const;

// Progressive retry delays to give services like Neon time to wake from auto-suspend
// First retry: 1s, Second retry: 2s, Third retry: 3s
const RETRY_DELAYS_MS = [1000, 2000, 3000] as const;

/**
 * Adds random jitter to prevent thundering herd when multiple operations retry simultaneously
 * @param ms Base delay in milliseconds
 * @returns Jittered delay (base + 0-250ms random)
 */
const jitter = (ms: number): number => ms + Math.floor(Math.random() * 250);

// Network error message patterns that indicate retryable connection issues
// These catch cases where Prisma doesn't provide proper error codes but surface network problems
const RETRYABLE_MESSAGE_PATTERNS = [
  /Can't reach database server/i,        // Prisma's standard unreachable host message
  /ECONNREFUSED/i,                       // Connection refused - port closed or service unavailable
  /ETIMEDOUT/i,                          // Connection or query timeout - slow network/overloaded server
  /ECONNRESET/i,                         // Connection reset by peer - network interruption or server restart
  /EAI_AGAIN|ENOTFOUND/i,               // DNS resolution failures - temporary name resolution issues
  /server closed the connection/i,       // Server-initiated connection termination
  /Connection terminated/i,              // Generic connection termination (client or server side)
  /connection terminated unexpectedly/i, // Unexpected connection drops during operation
] as const;

/**
 * Determines if an error is retryable based on error type, codes, and message patterns
 * Enhanced to handle Neon auto-suspend scenarios where errorCode may be undefined
 */
function isRetryable(e: unknown): boolean {
  // 1) ALL PrismaClientInitializationError are retryable 
  //    (these are almost always transient connection issues, even without errorCode)
  if (e instanceof Prisma.PrismaClientInitializationError) {
    return true;
  }

  // 2) Known request errors with specific retryable codes
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return (RETRYABLE_CODES as readonly string[]).includes(e.code as string);
  }

  // 3) Unknown request errors - check message patterns for connection issues
  //    (sometimes connection issues surface as this error type without proper codes)
  if (e instanceof Prisma.PrismaClientUnknownRequestError) {
    const msg = e.message ?? '';
    return RETRYABLE_MESSAGE_PATTERNS.some(pattern => pattern.test(msg));
  }

  // 4) Generic fallback - check message patterns for other network-related errors
  const errorMessage = (e as { message?: string })?.message ?? '';
  if (typeof errorMessage === 'string') {
    return RETRYABLE_MESSAGE_PATTERNS.some(pattern => pattern.test(errorMessage));
  }

  return false;
}

/**
 * Gets a human-readable error identifier for logging purposes
 * Provides specific identifiers for different Prisma error types to aid in log analysis
 */
function getErrorIdentifier(e: unknown): string {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return e.code;
  }
  if (e instanceof Prisma.PrismaClientUnknownRequestError) {
    return 'PRISMA_UNKNOWN_REQUEST_ERROR';
  }
  if (e instanceof Prisma.PrismaClientInitializationError) {
    return e.errorCode ?? 'PRISMA_CLIENT_INITIALIZATION_ERROR';
  }
  return 'UNKNOWN_ERROR_PRISMA';
}

/* ─── Prisma client singleton ────────────────────────────────────── */
// Create a type-safe wrapper around globalThis to store PrismaClient instance  
const globalForPrisma = globalThis as { prisma?: PrismaClient };

/* ---- Enhanced query-level extension: multiple retries for connection errors ----- */
// Create once, reuse forever (no double $extends in dev HMR reloads)
const prisma = globalForPrisma.prisma ?? 
  new PrismaClient().$extends(
    Prisma.defineExtension({
      name: 'enhanced-connection-retry',
      query: {
        $allModels: {
          async $allOperations<R, A>({
            model,
            operation,
            args,
            query,
          }: {
            model: string;
            operation: string;
            args: A;
            query: (a: A) => Promise<R>;
          }): Promise<R> {
            // Track retry attempts for this operation
            let lastError: unknown;
            
            // Initial attempt + retries
            for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
              try {
                return await query(args);
              } catch (err) {
                lastError = err;
                
                // If this isn't a retryable error, fail immediately
                if (!isRetryable(err)) {
                  throw err;
                }

                // If we've exhausted all retries, throw the last error
                if (attempt >= RETRY_DELAYS_MS.length) {
                  throw err;
                }

                // Calculate delay for this retry attempt
                const delayMs = RETRY_DELAYS_MS[attempt];
                const errorId = getErrorIdentifier(err);
                
                console.warn(
                  `[Prisma] ${model}.${operation} hit ${errorId} (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1}) – retrying in ${delayMs / 1000}s…`,
                  (err as Error).message?.slice(0, 100) + '…' // Truncate long messages
                );

                // Wait before retry → gives services like Neon time to wake from auto-suspend
                // Add jitter to prevent thundering herd when multiple queries retry together
                await new Promise(resolve => setTimeout(resolve, jitter(delayMs)));
              }
            }

            // This should never be reached, but TypeScript requires it
            throw lastError;
          },
        },
      },
    })
  ) as PrismaClient;

// Save prisma instance to our wrapper in development only
// This prevents multiple instances during Next.js hot reloading
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
