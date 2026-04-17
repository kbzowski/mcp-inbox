import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/**
 * Vitest globalSetup for integration tests.
 *
 * Spawns a GreenMail container (in-memory IMAP/SMTP server, intended
 * for test automation), exposes its IMAP + SMTP ports on the host, and
 * publishes the coordinates via env so individual test files can build
 * ToolContexts against the live server.
 *
 * `greenmail.auth.disabled` means any credentials are accepted - we
 * still set IMAP_USER / IMAP_PASSWORD to "test" because several codepaths
 * assume the env is populated.
 */

let container: StartedTestContainer | null = null;

export async function setup(): Promise<void> {
  // Skip gracefully if Docker isn't available (e.g. local dev without
  // Docker Desktop running). Tests run via `passWithNoTests: true` and
  // the test files themselves check for the env markers.
  try {
    container = await new GenericContainer('greenmail/standalone:2.1.0')
      .withExposedPorts(3143, 3025)
      .withEnvironment({
        // hostname=0.0.0.0 is critical - by default GreenMail binds to
        // 127.0.0.1 inside the container, which Docker port forwarding
        // can't route to. Without it, TCP handshakes succeed at the
        // proxy layer but the server never sees the connection and
        // ImapFlow reports ClosedAfterConnectText.
        GREENMAIL_OPTS:
          '-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=test:test@localhost -Dgreenmail.verbose',
      })
      // Port-open alone isn't enough - GreenMail briefly accepts then drops
      // connections while its server list initializes. Wait for the log
      // line it prints after every server (IMAP/SMTP/POP3) is ready.
      .withWaitStrategy(Wait.forLogMessage(/Starting GreenMail standalone/i))
      .withStartupTimeout(90_000)
      .start();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[integration] Skipping GreenMail setup - Docker not reachable: ${msg}\n`);
    return;
  }

  const host = container.getHost();
  process.env.GREENMAIL_HOST = host;
  process.env.GREENMAIL_IMAP_PORT = String(container.getMappedPort(3143));
  process.env.GREENMAIL_SMTP_PORT = String(container.getMappedPort(3025));

  process.stderr.write(
    `[integration] GreenMail ready at ${host}:${process.env.GREENMAIL_IMAP_PORT} (IMAP) / ${process.env.GREENMAIL_SMTP_PORT} (SMTP)\n`,
  );
}

export async function teardown(): Promise<void> {
  if (container) {
    await container.stop();
    container = null;
  }
}
