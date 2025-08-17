// lib/prisma.ts  – lazy Prisma client + *one* retry on connection errors

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

const RETRY_DELAY_MS = 1000;   // 1 second pause before the single retry

function isRetryable(e: unknown): boolean {
  return (
    (e instanceof Prisma.PrismaClientKnownRequestError &&
      // Cast to readonly string[] for better TypeScript compatibility with includes()
      (RETRYABLE_CODES as readonly string[]).includes(e.code as string)) ||
    (e instanceof Prisma.PrismaClientInitializationError &&
      // Cast to readonly string[] for better TypeScript compatibility with includes()
      (RETRYABLE_CODES as readonly string[]).includes((e.errorCode ?? '') as string))
  );
}

/* ─── Prisma client singleton ────────────────────────────────────── */
// Create a type-safe wrapper around globalThis to store PrismaClient instance
const globalForPrisma = globalThis as { prisma?: PrismaClient };
// Either use existing Prisma instance or create new one using nullish coalescing
const base = globalForPrisma.prisma ?? new PrismaClient();

/* ---- tiny query-level extension: one retry, no eager $connect ----- */
const prisma = base.$extends(
  Prisma.defineExtension({
    name: 'one-shot-connection-retry',
    query: {
      $allModels: {
        async $allOperations<R, A>({
          operation,
          args,
          query,
        }: {
          operation: string;
          args: A;
          query: (a: A) => Promise<R>;
        }): Promise<R> {
          try {
            // First attempt → Cold DB timeout
            return await query(args);
          } catch (err) {
            // non-connection error → bubble up
            if (!isRetryable(err)) throw err;

            console.warn(
              `[Prisma] ${operation} hit ${(
                err as { code?: string; errorCode?: string }
              ).code ?? 'no error code, assuming: P1001'} – retrying once in ${RETRY_DELAY_MS / 1_000}s`
            );
            // Wait 1 second → Neon warms up
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            // Second attempt (single retry) → Warm DB succeeds
            return await query(args);
          }
        },
      },
    },
  })
) as PrismaClient;

// Save prisma instance to our wrapper in development only
// This prevents multiple instances during Next.js hot reloading
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
