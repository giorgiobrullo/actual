import createDebug from 'debug';
import Imap from 'imap';

import { SecretName, secretsService } from '#services/secrets-service';

const debug = createDebug('actual:amex:imap');

export type ImapConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
  folder?: string;
};

/**
 * Get IMAP configuration from secrets
 */
function getImapConfig(): ImapConfig | null {
  const host = secretsService.get(SecretName.amex_imap_host);
  const port = secretsService.get(SecretName.amex_imap_port);
  const user = secretsService.get(SecretName.amex_imap_user);
  const password = secretsService.get(SecretName.amex_imap_password);
  const folder = secretsService.get(SecretName.amex_imap_folder);

  if (!host || !user || !password) {
    return null;
  }

  return {
    host,
    port: port ? parseInt(port, 10) : 993,
    user,
    password,
    tls: true,
    folder: folder || undefined,
  };
}

/**
 * Check if IMAP is configured
 */
export function isImapConfigured(): boolean {
  return getImapConfig() !== null;
}

/**
 * Wait for and extract Amex verification code from email
 * @param sinceTime - Only look for emails after this timestamp
 * @param maxWaitMs - Maximum time to wait for the email (default 2 minutes)
 * @returns The verification code, or null if not found
 */
export async function waitForAmexVerificationCode(
  sinceTime: Date,
  maxWaitMs: number = 120000,
): Promise<string | null> {
  const config = getImapConfig();
  if (!config) {
    debug('IMAP not configured');
    return null;
  }

  debug(
    'Waiting for Amex verification email (since %s)...',
    sinceTime.toISOString(),
  );

  const startTime = Date.now();
  const pollInterval = 5000; // Check every 5 seconds
  let attempt = 0;

  while (Date.now() - startTime < maxWaitMs) {
    attempt++;
    debug('Check attempt %d...', attempt);

    const code = await checkForVerificationEmail(config, sinceTime);
    if (code) {
      debug('Found verification code: %s', code);
      return code;
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const remaining = Math.round((maxWaitMs - (Date.now() - startTime)) / 1000);
    debug(
      'No code yet (%ds elapsed, %ds remaining). Waiting 5s...',
      elapsed,
      remaining,
    );
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  debug('Timeout waiting for verification email');
  return null;
}

/**
 * Check mailbox for Amex verification email
 * If found, deletes the email after extracting the code
 */
async function checkForVerificationEmail(
  config: ImapConfig,
  sinceTime: Date,
): Promise<string | null> {
  return new Promise(resolve => {
    const imap = new Imap({
      user: config.user,
      password: config.password,
      host: config.host,
      port: config.port,
      tls: config.tls,
      tlsOptions: { rejectUnauthorized: false },
    });

    let foundCode: string | null = null;
    let foundCodeDate: Date | null = null;
    let foundMessageSeqNo: number | null = null;

    imap.once('ready', () => {
      debug('IMAP connected');

      const mailbox = config.folder || 'INBOX';
      // Open in read-write mode (false = not read-only) so we can delete emails
      imap.openBox(mailbox, false, (err, _box) => {
        if (err) {
          debug('Error opening mailbox %s: %s', mailbox, err.message);
          imap.end();
          resolve(null);
          return;
        }

        // Search for recent emails from Amex
        const searchDate = sinceTime.toISOString().split('T')[0]; // Format: YYYY-MM-DD
        const searchCriteria = [
          ['SINCE', searchDate],
          ['FROM', 'americanexpress'],
        ];

        imap.search(searchCriteria, (err, results) => {
          if (err) {
            debug('Error searching: %s', err.message);
            imap.end();
            resolve(null);
            return;
          }

          if (!results || results.length === 0) {
            debug('No matching emails found');
            imap.end();
            resolve(null);
            return;
          }

          debug('Found %d potential emails', results.length);

          // Fetch the most recent emails
          const fetch = imap.fetch(results.slice(-5), {
            bodies: ['TEXT', 'HEADER.FIELDS (FROM SUBJECT DATE)'],
            struct: true,
          });

          fetch.on('message', (msg, seqno) => {
            let bodyText = '';
            let headers = '';
            const currentSeqNo = seqno;

            msg.on('body', (stream, info) => {
              let buffer = '';
              stream.on('data', chunk => {
                buffer += chunk.toString('utf8');
              });
              stream.once('end', () => {
                if (info.which === 'TEXT') {
                  bodyText = buffer;
                } else {
                  headers = buffer;
                }
              });
            });

            msg.once('end', () => {
              // Parse the Date header and check if email arrived after sinceTime
              const dateMatch = headers.match(/Date:\s*(.+)/i);
              let emailDate: Date | null = null;
              if (dateMatch) {
                emailDate = new Date(dateMatch[1].trim());
                // Add 1 second buffer because email Date headers only have second precision
                // e.g., email at 15:02:24.000Z should match request at 15:02:24.138Z
                const sinceTimeWithBuffer = new Date(
                  sinceTime.getTime() - 1000,
                );
                if (emailDate < sinceTimeWithBuffer) {
                  debug(
                    'Skipping email from %s (before request time %s minus 1s buffer)',
                    emailDate.toISOString(),
                    sinceTime.toISOString(),
                  );
                  return; // Skip emails that arrived before we requested the code
                }
                debug(
                  'Email date %s is after request time %s (with 1s buffer)',
                  emailDate.toISOString(),
                  sinceTime.toISOString(),
                );
              }

              // Check if this is the verification email
              const subjectLower = headers.toLowerCase();
              const bodyLower = bodyText.toLowerCase();

              const isVerificationEmail =
                subjectLower.includes('codice di sicurezza') ||
                subjectLower.includes('verification') ||
                subjectLower.includes('codice temporaneo') ||
                bodyLower.includes('codice di autenticazione temporaneo');

              if (isVerificationEmail) {
                debug('Found Amex verification email (after sinceTime check)');

                // Try specific pattern first: code appears after "temporaneo è:" in Italian emails
                // Pattern: "Il tuo codice di autenticazione temporaneo è:" followed by 6 digits
                const italianPattern =
                  /codice di autenticazione temporaneo[^0-9]*(\d{6})/i;
                let match = bodyText.match(italianPattern);

                // Also try pattern where code is in a styled element (HTML)
                if (!match) {
                  // Look for code in styled div/p elements (color: #006fcf is Amex blue)
                  const htmlPattern = /<p[^>]*>(\d{6})<\/p>/i;
                  match = bodyText.match(htmlPattern);
                }

                // Fallback: any standalone 6-digit number
                if (!match) {
                  match = bodyText.match(/\b(\d{6})\b/);
                }

                if (match) {
                  // Only update if this email is newer than any previously found
                  if (
                    !foundCodeDate ||
                    (emailDate && emailDate > foundCodeDate)
                  ) {
                    debug(
                      'Found verification code: %s (newer than previous)',
                      match[1],
                    );
                    foundCode = match[1];
                    foundCodeDate = emailDate;
                    foundMessageSeqNo = currentSeqNo;
                  } else {
                    debug(
                      'Skipping code %s (older than already found)',
                      match[1],
                    );
                  }
                }
              }
            });
          });

          fetch.once('error', err => {
            debug('Fetch error: %s', err.message);
          });

          fetch.once('end', () => {
            debug('Fetch complete, foundCode: %s', foundCode);

            // If we found a code, delete the email before closing
            if (foundCode && foundMessageSeqNo) {
              debug(
                'Deleting verification email (seqno: %d)...',
                foundMessageSeqNo,
              );
              imap.addFlags(foundMessageSeqNo, ['\\Deleted'], err => {
                if (err) {
                  debug('Error marking email for deletion: %s', err.message);
                  imap.end();
                  resolve(foundCode);
                  return;
                }

                // Expunge to permanently delete
                imap.expunge(err => {
                  if (err) {
                    debug('Error expunging email: %s', err.message);
                  } else {
                    debug('Verification email deleted successfully');
                  }
                  imap.end();
                  resolve(foundCode);
                });
              });
            } else {
              imap.end();
              resolve(foundCode);
            }
          });
        });
      });
    });

    imap.once('error', (err: Error) => {
      debug('IMAP error: %s', err.message);
      resolve(null);
    });

    imap.once('end', () => {
      debug('IMAP connection closed');
      // Don't resolve here anymore - we resolve in fetch.once('end')
    });

    imap.connect();
  });
}

/**
 * Debug function to check for Amex emails and return details
 * This helps diagnose why verification codes might not be found
 * @param providedConfig - Optional config to use instead of reading from secrets
 */
export async function debugCheckAmexEmails(providedConfig?: {
  host: string;
  port?: number;
  user: string;
  password: string;
  folder?: string;
}): Promise<{
  success: boolean;
  message: string;
  emails?: Array<{
    subject: string;
    from: string;
    date: string;
    bodyPreview: string;
    foundCode: string | null;
  }>;
}> {
  // Use provided config or fall back to secrets
  const config = providedConfig
    ? {
        host: providedConfig.host,
        port: providedConfig.port || 993,
        user: providedConfig.user,
        password: providedConfig.password,
        tls: true,
        folder: providedConfig.folder,
      }
    : getImapConfig();

  console.log(
    '[IMAP Debug] Starting debug check, config:',
    config ? 'found' : 'not found',
  );
  if (config?.folder) {
    console.log('[IMAP Debug] Using folder:', config.folder);
  }

  if (!config) {
    return { success: false, message: 'IMAP not configured' };
  }

  return new Promise(resolve => {
    let resolved = false;
    const safeResolve = (result: {
      success: boolean;
      message: string;
      emails?: Array<{
        subject: string;
        from: string;
        date: string;
        bodyPreview: string;
        foundCode: string | null;
      }>;
    }) => {
      if (!resolved) {
        resolved = true;
        console.log('[IMAP Debug] Resolving with:', result.message);
        resolve(result);
      }
    };

    // Add timeout to prevent hanging forever
    const timeout = setTimeout(() => {
      console.log('[IMAP Debug] TIMEOUT - 30 seconds elapsed');
      try {
        imap.end();
      } catch {
        // Ignore cleanup errors
      }
      safeResolve({
        success: false,
        message: 'Operation timed out after 30 seconds',
      });
    }, 30000);

    console.log('[IMAP Debug] Creating IMAP connection to', config.host);
    const imap = new Imap({
      user: config.user,
      password: config.password,
      host: config.host,
      port: config.port,
      tls: config.tls,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 10000,
      authTimeout: 10000,
    });

    const emails: Array<{
      subject: string;
      from: string;
      date: string;
      bodyPreview: string;
      foundCode: string | null;
    }> = [];

    imap.once('ready', () => {
      console.log('[IMAP Debug] Connected! Listing mailboxes first...');

      // First list all available mailboxes
      imap.getBoxes((err, boxes) => {
        if (err) {
          console.log('[IMAP Debug] Error listing mailboxes:', err.message);
        } else {
          console.log('[IMAP Debug] Available mailboxes:', Object.keys(boxes));
          // Also log nested boxes and delimiter
          for (const [name, box] of Object.entries(boxes)) {
            console.log(`[IMAP Debug]   ${name} delimiter:`, box.delimiter);
            if (box.children) {
              console.log(
                `[IMAP Debug]   ${name} children:`,
                Object.keys(box.children),
              );
            }
          }
        }

        // Use configured folder or default to INBOX
        const mailbox = config.folder || 'INBOX';
        console.log('[IMAP Debug] Opening mailbox:', mailbox);
        imap.openBox(mailbox, true, (err, box) => {
          if (err) {
            console.log('[IMAP Debug] Error opening mailbox:', err.message);
            clearTimeout(timeout);
            imap.end();
            safeResolve({
              success: false,
              message: `Error opening inbox: ${err.message}`,
            });
            return;
          }

          console.log(
            '[IMAP Debug] Inbox opened, total messages:',
            box.messages.total,
          );

          // Search for recent emails (last 7 days)
          const searchDate = new Date();
          searchDate.setDate(searchDate.getDate() - 7);
          const searchDateStr = searchDate.toISOString().split('T')[0];

          console.log(
            '[IMAP Debug] Searching for emails since:',
            searchDateStr,
          );

          imap.search([['SINCE', searchDateStr]], (err, results) => {
            if (err) {
              console.log('[IMAP Debug] Search error:', err.message);
              clearTimeout(timeout);
              imap.end();
              safeResolve({
                success: false,
                message: `Search error: ${err.message}`,
              });
              return;
            }

            console.log(
              '[IMAP Debug] Search found',
              results?.length || 0,
              'emails',
            );

            if (!results || results.length === 0) {
              clearTimeout(timeout);
              imap.end();
              safeResolve({
                success: true,
                message: 'No emails found in the last 7 days',
                emails: [],
              });
              return;
            }

            // Fetch only the last 5 emails to keep it fast
            const toFetch = results.slice(-5);
            console.log(
              '[IMAP Debug] Fetching',
              toFetch.length,
              'emails (IDs:',
              toFetch.join(', '),
              ')',
            );

            const fetch = imap.fetch(toFetch, {
              bodies: ['HEADER.FIELDS (FROM SUBJECT DATE)', 'TEXT'],
              struct: false,
            });

            let pendingMessages = toFetch.length;
            console.log('[IMAP Debug] Pending messages:', pendingMessages);

            fetch.on('message', (msg, seqno) => {
              console.log('[IMAP Debug] Processing message', seqno);
              let headers = '';
              let bodyText = '';

              msg.on('body', (stream, info) => {
                let buffer = '';
                stream.on('data', chunk => {
                  buffer += chunk.toString('utf8');
                });
                stream.once('end', () => {
                  if (info.which === 'TEXT') {
                    bodyText = buffer;
                  } else {
                    headers = buffer;
                  }
                });
              });

              msg.once('end', () => {
                console.log('[IMAP Debug] Message', seqno, 'end event');

                // Parse headers
                const fromMatch = headers.match(/From:\s*(.+)/i);
                const subjectMatch = headers.match(/Subject:\s*(.+)/i);
                const dateMatch = headers.match(/Date:\s*(.+)/i);

                const from = fromMatch ? fromMatch[1].trim() : 'unknown';
                const subject = subjectMatch
                  ? subjectMatch[1].trim()
                  : 'no subject';
                const date = dateMatch ? dateMatch[1].trim() : 'unknown';

                // Try to find verification code in body - only for Amex emails with verification subject
                let foundCode: string | null = null;
                const isFromAmex =
                  from.toLowerCase().includes('americanexpress') ||
                  from.toLowerCase().includes('amex');
                const isVerificationEmail =
                  subject.toLowerCase().includes('codice') &&
                  subject.toLowerCase().includes('sicurezza');

                if (bodyText && isFromAmex && isVerificationEmail) {
                  // Try specific pattern first
                  const italianPattern =
                    /codice di autenticazione temporaneo[^0-9]*(\d{6})/i;
                  let match = bodyText.match(italianPattern);

                  // Try HTML pattern
                  if (!match) {
                    const htmlPattern = /<p[^>]*>(\d{6})<\/p>/i;
                    match = bodyText.match(htmlPattern);
                  }

                  // Fallback: any standalone 6-digit number (only for verified Amex emails)
                  if (!match) {
                    match = bodyText.match(/\b(\d{6})\b/);
                  }

                  if (match) {
                    foundCode = match[1];
                    console.log(
                      '[IMAP Debug] Found code in Amex verification email:',
                      foundCode,
                    );
                  }
                }

                emails.push({
                  subject: subject.substring(0, 100),
                  from: from.substring(0, 100),
                  date,
                  bodyPreview: bodyText
                    ? bodyText.substring(0, 200).replace(/\s+/g, ' ')
                    : '(no body)',
                  foundCode,
                });

                pendingMessages--;
                console.log(
                  '[IMAP Debug] Pending messages remaining:',
                  pendingMessages,
                );

                if (pendingMessages === 0) {
                  console.log(
                    '[IMAP Debug] All messages processed, resolving now...',
                  );
                  clearTimeout(timeout);

                  // Sort by date (newest first)
                  const sortedEmails = emails.sort((a, b) => {
                    const dateA = new Date(a.date).getTime();
                    const dateB = new Date(b.date).getTime();
                    return dateB - dateA; // Newest first
                  });

                  // Resolve immediately, don't wait for end event
                  safeResolve({
                    success: true,
                    message: `Found ${emails.length} emails`,
                    emails: sortedEmails,
                  });

                  // Try to close connection (may not fire 'end' event)
                  try {
                    imap.end();
                  } catch {
                    // Ignore
                  }
                }
              });
            });

            fetch.once('error', err => {
              console.log('[IMAP Debug] Fetch error:', err.message);
              clearTimeout(timeout);
              safeResolve({
                success: false,
                message: `Fetch error: ${err.message}`,
              });
              try {
                imap.end();
              } catch {
                // Ignore
              }
            });

            fetch.once('end', () => {
              console.log(
                '[IMAP Debug] Fetch stream ended, pending:',
                pendingMessages,
              );
            });
          });
        });
      });
    });

    imap.once('error', (err: Error) => {
      console.log('[IMAP Debug] IMAP error:', err.message);
      clearTimeout(timeout);
      safeResolve({ success: false, message: `IMAP error: ${err.message}` });
    });

    imap.once('end', () => {
      console.log('[IMAP Debug] Connection closed');
    });

    console.log('[IMAP Debug] Calling imap.connect()...');
    imap.connect();
  });
}

/**
 * Test IMAP connection with provided credentials
 * @returns Promise with success status and message
 */
export async function testImapConnection(config: {
  host: string;
  port?: number;
  user: string;
  password: string;
}): Promise<{ success: boolean; message: string }> {
  return new Promise(resolve => {
    const imap = new Imap({
      user: config.user,
      password: config.password,
      host: config.host,
      port: config.port || 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 10000,
      authTimeout: 10000,
    });

    const timeout = setTimeout(() => {
      debug('IMAP connection timeout');
      try {
        imap.end();
      } catch {
        // Ignore errors on cleanup
      }
      resolve({ success: false, message: 'Connection timed out' });
    }, 15000);

    imap.once('ready', () => {
      debug('IMAP test connection successful');
      clearTimeout(timeout);
      imap.end();
      resolve({
        success: true,
        message: 'Successfully connected to IMAP server',
      });
    });

    imap.once('error', (err: Error) => {
      debug('IMAP test error: %s', err.message);
      clearTimeout(timeout);
      resolve({ success: false, message: `Connection failed: ${err.message}` });
    });

    debug('Testing IMAP connection to %s:%d', config.host, config.port || 993);
    imap.connect();
  });
}
