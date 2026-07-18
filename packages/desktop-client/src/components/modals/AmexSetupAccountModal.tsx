import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { AnimatedLoading } from '@actual-app/components/icons/AnimatedLoading';
import { Input } from '@actual-app/components/input';
import { Paragraph } from '@actual-app/components/paragraph';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { isDevelopmentEnvironment } from '@actual-app/core/shared/environment';
import type {
  AmexErrorCode,
  AmexErrorInterface,
  AmexToken,
} from '@actual-app/core/types/models/amex';

import { Error, Warning } from '#components/alerts';
import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { FormField, FormLabel } from '#components/forms';
import type { Modal as ModalType } from '#modals/modalsSlice';

function renderError(
  error: AmexErrorInterface,
  t: ReturnType<typeof useTranslation>['t'],
) {
  // Use the detailed error_type message from the backend when available,
  // as it contains more specific information about what went wrong
  if (error.error_type) {
    return (
      <Error style={{ alignSelf: 'center', marginBottom: 10 }}>
        {error.error_type}
      </Error>
    );
  }

  // Fallback messages only when error_type is not provided
  const error_messages: Partial<Record<AmexErrorCode, string>> = {
    TIMED_OUT: t('Timed out. Please try again.'),
    AMEX_NOT_CONFIGURED: t(
      'Amex is not configured. Please enter your credentials.',
    ),
    AMEX_AUTH_FAILED: t(
      'Authentication failed. Please check your username and password.',
    ),
    AMEX_2FA_REQUIRED: t(
      'Two-factor authentication is required. This is not yet supported.',
    ),
    AMEX_SESSION_EXPIRED: t('Session expired. Please try again.'),
    INTERNAL_ERROR: t('An internal error occurred. Please try again.'),
  };

  return (
    <Error style={{ alignSelf: 'center', marginBottom: 10 }}>
      {error.error_code in error_messages
        ? error_messages[error.error_code]
        : t('An unknown error occurred.')}
    </Error>
  );
}

const WaitingIndicator = ({ message }: { message: string }) => {
  return (
    <View style={{ alignItems: 'center', marginTop: 15 }}>
      <AnimatedLoading
        color={theme.pageTextDark}
        style={{ width: 20, height: 20 }}
      />
      <View style={{ marginTop: 10, color: theme.pageText }}>{message}</View>
    </View>
  );
};

type AmexSetupAccountModalProps = Extract<
  ModalType,
  { name: 'amex-setup-account' }
>['options'];

export function AmexSetupAccountModal({
  onSuccess,
}: AmexSetupAccountModalProps) {
  const { t } = useTranslation();

  const [error, setError] = useState<AmexErrorInterface | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [token, setToken] = useState<AmexToken | null>(null);
  const [showImapConfig, setShowImapConfig] = useState(false);
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('993');
  const [imapUser, setImapUser] = useState('');
  const [imapPassword, setImapPassword] = useState('');
  const [imapFolder, setImapFolder] = useState('');
  const [isTestingImap, setIsTestingImap] = useState(false);
  const [imapTestResult, setImapTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [debugResult, setDebugResult] = useState<string | null>(null);
  const [isDebugging, setIsDebugging] = useState(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);
  const [isConfigured, setIsConfigured] = useState(false);
  const [showNewCredentials, setShowNewCredentials] = useState(false);

  // CAPTCHA solver state
  const [showCaptchaConfig, setShowCaptchaConfig] = useState(false);
  const [captchaApiKey, setCaptchaApiKey] = useState('');
  const [isCaptchaConfigured, setIsCaptchaConfigured] = useState(false);
  const [isTestingCaptcha, setIsTestingCaptcha] = useState(false);
  const [captchaTestResult, setCaptchaTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Proxy state
  const [showProxyConfig, setShowProxyConfig] = useState(false);
  const [proxyUrl, setProxyUrl] = useState('');
  const [isProxyConfigured, setIsProxyConfigured] = useState(false);
  const [isTestingProxy, setIsTestingProxy] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Check if credentials are already configured on mount
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const result = await send('amex-status');
        if (result?.data?.configured) {
          setIsConfigured(true);
        }
        if (result?.data?.captchaSolverConfigured) {
          setIsCaptchaConfigured(true);
        }
        if (result?.data?.proxyConfigured) {
          setIsProxyConfigured(true);
        }
      } catch {
        // Ignore errors, just show the form
      } finally {
        setIsCheckingStatus(false);
      }
    };
    void checkStatus();
  }, []);

  const handleTestImap = async () => {
    if (!imapHost || !imapUser || !imapPassword) {
      setImapTestResult({
        success: false,
        message: t('Please fill in all IMAP fields'),
      });
      return;
    }

    setIsTestingImap(true);
    setImapTestResult(null);

    try {
      const result = await send('amex-test-imap', {
        host: imapHost,
        port: parseInt(imapPort, 10) || 993,
        user: imapUser,
        password: imapPassword,
      });

      if (result?.error) {
        setImapTestResult({
          success: false,
          message: result.error.error_type || t('Test failed'),
        });
      } else if (result?.data) {
        setImapTestResult(result.data);
      }
    } catch (err) {
      setImapTestResult({
        success: false,
        message: String(err),
      });
    } finally {
      setIsTestingImap(false);
    }
  };

  const handleDebugImap = async () => {
    if (!imapHost || !imapUser || !imapPassword) {
      setDebugResult('Error: Please fill in all IMAP fields first');
      return;
    }

    setIsDebugging(true);
    setDebugResult(null);

    try {
      const result = await send('amex-debug-imap', {
        host: imapHost,
        port: parseInt(imapPort, 10) || 993,
        user: imapUser,
        password: imapPassword,
        folder: imapFolder || undefined,
      });

      if (result?.error) {
        setDebugResult(`Error: ${result.error.error_type}`);
      } else if (result?.data) {
        // Format the debug result
        const data = result.data;
        let output = `${data.message}\n\n`;
        if (data.emails && data.emails.length > 0) {
          data.emails.forEach((email, i) => {
            output += `--- Email ${i + 1} ---\n`;
            output += `From: ${email.from}\n`;
            output += `Subject: ${email.subject}\n`;
            output += `Date: ${email.date}\n`;
            output += `Code Found: ${email.foundCode || 'None'}\n`;
            output += `Preview: ${email.bodyPreview}\n\n`;
          });
        }
        setDebugResult(output);
      }
    } catch (err) {
      setDebugResult(`Error: ${String(err)}`);
    } finally {
      setIsDebugging(false);
    }
  };

  const handleTestCaptcha = async () => {
    if (!captchaApiKey) {
      setCaptchaTestResult({
        success: false,
        message: t('Please enter a 2Captcha API key'),
      });
      return;
    }

    setIsTestingCaptcha(true);
    setCaptchaTestResult(null);

    try {
      const result = await send('amex-test-captcha', {
        apiKey: captchaApiKey,
      });

      if (result?.error) {
        setCaptchaTestResult({
          success: false,
          message: result.error.error_type || t('Test failed'),
        });
      } else if (result?.data) {
        setCaptchaTestResult({
          success: true,
          message: t('API key valid. Balance: {{balance}}', {
            balance: `$${result.data.balance}`,
          }),
        });
      }
    } catch (err) {
      setCaptchaTestResult({
        success: false,
        message: String(err),
      });
    } finally {
      setIsTestingCaptcha(false);
    }
  };

  const handleTestProxy = async () => {
    if (!proxyUrl) {
      setProxyTestResult({
        success: false,
        message: t('Please enter a proxy URL'),
      });
      return;
    }

    setIsTestingProxy(true);
    setProxyTestResult(null);

    try {
      const result = await send('amex-test-proxy', {
        proxy: proxyUrl,
      });

      if (result?.error) {
        setProxyTestResult({
          success: false,
          message: result.error.error_type || t('Test failed'),
        });
      } else if (result?.data) {
        if (result.data.success) {
          setProxyTestResult({
            success: true,
            message: t('Proxy working. Exit IP: {{ip}}', {
              ip: result.data.ip,
            }),
          });
        } else {
          setProxyTestResult({
            success: false,
            message: result.data.message || t('Test failed'),
          });
        }
      }
    } catch (err) {
      setProxyTestResult({
        success: false,
        message: String(err),
      });
    } finally {
      setIsTestingProxy(false);
    }
  };

  // Login with saved credentials (no need to re-enter)
  const handleLoginWithSaved = async () => {
    setError(null);
    setIsLoggingIn(true);

    try {
      // Update captcha/proxy settings if provided (credentials already saved)
      if (captchaApiKey || proxyUrl) {
        const configResult = await send('amex-configure', {
          username: null,
          password: null,
          proxy: proxyUrl || undefined,
          captchaApiKey: captchaApiKey || undefined,
        });
        if (configResult?.error) {
          setError(configResult.error);
          setIsLoggingIn(false);
          return;
        }
        if (captchaApiKey) {
          setIsCaptchaConfigured(true);
          setCaptchaApiKey('');
        }
        if (proxyUrl) {
          setIsProxyConfigured(true);
          setProxyUrl('');
        }
      }

      const loginResult = await send('amex-login');
      if (loginResult?.error) {
        setError(loginResult.error);
        setIsLoggingIn(false);
        return;
      }

      if (loginResult?.data) {
        setToken({ accounts: loginResult.data.accounts });
      }
    } catch (err) {
      setError({
        error_code: 'INTERNAL_ERROR',
        error_type: String(err),
      });
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogin = async () => {
    if (!username || !password) {
      setError({
        error_code: 'BAD_REQUEST',
        error_type: t('Please enter both username and password.'),
      });
      return;
    }

    setError(null);
    setIsLoggingIn(true);

    try {
      // Build IMAP config if provided
      const imap =
        showImapConfig && imapHost && imapUser && imapPassword
          ? {
              host: imapHost,
              port: parseInt(imapPort, 10) || 993,
              user: imapUser,
              password: imapPassword,
              folder: imapFolder || undefined,
            }
          : undefined;

      // Configure all settings in one call
      const configResult = await send('amex-configure', {
        username,
        password,
        imap,
        proxy: proxyUrl || undefined,
        captchaApiKey: captchaApiKey || undefined,
      });
      if (configResult?.error) {
        setError(configResult.error);
        setIsLoggingIn(false);
        return;
      }

      // Update UI state for configured options
      if (captchaApiKey) {
        setIsCaptchaConfigured(true);
        setCaptchaApiKey('');
      }
      if (proxyUrl) {
        setIsProxyConfigured(true);
        setProxyUrl('');
      }

      // Then attempt login
      const loginResult = await send('amex-login');
      if (loginResult?.error) {
        setError(loginResult.error);
        setIsLoggingIn(false);
        return;
      }

      if (loginResult?.data) {
        setToken({ accounts: loginResult.data.accounts });
      }
    } catch (err) {
      setError({
        error_code: 'INTERNAL_ERROR',
        error_type: String(err),
      });
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleContinue = async () => {
    if (token) {
      await onSuccess(token);
    }
  };

  return (
    <Modal
      name="amex-setup-account"
      containerProps={{ style: { width: '35vw', minWidth: 400 } }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Link American Express')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View>
            {error && renderError(error, t)}

            {isCheckingStatus ? (
              <WaitingIndicator message={t('Checking configuration...')} />
            ) : !token ? (
              <>
                {/* Already configured - show quick login option */}
                {isConfigured && !showNewCredentials ? (
                  <>
                    <Paragraph style={{ fontSize: 15 }}>
                      <Trans>
                        Your American Express credentials are already
                        configured. Click below to log in and discover your
                        accounts.
                      </Trans>
                    </Paragraph>

                    {isLoggingIn ? (
                      <WaitingIndicator
                        message={t(
                          'Logging in to American Express. This may take a moment...',
                        )}
                      />
                    ) : (
                      <>
                        <ButtonWithLoading
                          variant="primary"
                          style={{
                            padding: '10px 0',
                            fontSize: 15,
                            fontWeight: 600,
                            marginTop: 15,
                          }}
                          onPress={handleLoginWithSaved}
                          isLoading={isLoggingIn}
                        >
                          <Trans>Log in with saved credentials</Trans>
                        </ButtonWithLoading>

                        <Button
                          variant="bare"
                          style={{
                            marginTop: 10,
                            fontSize: 13,
                          }}
                          onPress={() => setShowNewCredentials(true)}
                        >
                          <Trans>Update credentials</Trans>
                        </Button>
                      </>
                    )}
                  </>
                ) : (
                  /* Not configured or user wants to update - show credential form */
                  <>
                    <Paragraph style={{ fontSize: 15 }}>
                      <Trans>
                        Enter your American Express Italy credentials. Your
                        credentials will be stored securely on your server and
                        used to sync transactions.
                      </Trans>
                    </Paragraph>

                    <Warning style={{ marginBottom: 15 }}>
                      <Trans>
                        This feature uses browser automation to log into your
                        Amex account. Your credentials are stored on your sync
                        server. Only use this if you trust your server
                        environment.
                      </Trans>
                    </Warning>

                    <FormField>
                      <FormLabel
                        title={t('Username')}
                        htmlFor="amex-username"
                      />
                      <Input
                        id="amex-username"
                        type="text"
                        value={username}
                        onChangeValue={setUsername}
                        placeholder={t('Enter your Amex username')}
                        disabled={isLoggingIn}
                      />
                    </FormField>

                    <FormField style={{ marginTop: 10 }}>
                      <FormLabel
                        title={t('Password')}
                        htmlFor="amex-password"
                      />
                      <Input
                        id="amex-password"
                        type="password"
                        value={password}
                        onChangeValue={setPassword}
                        placeholder={t('Enter your Amex password')}
                        disabled={isLoggingIn}
                      />
                    </FormField>

                    <View style={{ marginTop: 15 }}>
                      <Button
                        variant="bare"
                        onPress={() => setShowImapConfig(!showImapConfig)}
                        style={{ padding: 0, fontSize: 13 }}
                      >
                        {showImapConfig
                          ? t('▼ Hide 2FA email settings')
                          : t('▶ Configure 2FA email verification (optional)')}
                      </Button>

                      {showImapConfig && (
                        <View
                          style={{
                            marginTop: 10,
                            padding: 10,
                            backgroundColor: theme.tableRowBackgroundHover,
                            borderRadius: 4,
                          }}
                        >
                          <Text style={{ fontSize: 13, marginBottom: 10 }}>
                            <Trans>
                              If your Amex account requires 2FA, configure your
                              email IMAP settings to automatically read the
                              verification code.
                            </Trans>
                          </Text>

                          <FormField>
                            <FormLabel
                              title={t('IMAP Host')}
                              htmlFor="amex-imap-host"
                            />
                            <Input
                              id="amex-imap-host"
                              type="text"
                              value={imapHost}
                              onChangeValue={setImapHost}
                              placeholder={t('e.g., imap.gmail.com')}
                              disabled={isLoggingIn}
                            />
                          </FormField>

                          <FormField style={{ marginTop: 8 }}>
                            <FormLabel
                              title={t('IMAP Port')}
                              htmlFor="amex-imap-port"
                            />
                            <Input
                              id="amex-imap-port"
                              type="text"
                              value={imapPort}
                              onChangeValue={setImapPort}
                              placeholder="993"
                              disabled={isLoggingIn}
                            />
                          </FormField>

                          <FormField style={{ marginTop: 8 }}>
                            <FormLabel
                              title={t('Email Username')}
                              htmlFor="amex-imap-user"
                            />
                            <Input
                              id="amex-imap-user"
                              type="text"
                              value={imapUser}
                              onChangeValue={setImapUser}
                              placeholder={t('your@email.com')}
                              disabled={isLoggingIn}
                            />
                          </FormField>

                          <FormField style={{ marginTop: 8 }}>
                            <FormLabel
                              title={t('Email Password')}
                              htmlFor="amex-imap-password"
                            />
                            <Input
                              id="amex-imap-password"
                              type="password"
                              value={imapPassword}
                              onChangeValue={setImapPassword}
                              placeholder={t('App password recommended')}
                              disabled={isLoggingIn}
                            />
                          </FormField>

                          <FormField style={{ marginTop: 8 }}>
                            <FormLabel
                              title={t('Folder (optional)')}
                              htmlFor="amex-imap-folder"
                            />
                            <Input
                              id="amex-imap-folder"
                              type="text"
                              value={imapFolder}
                              onChangeValue={setImapFolder}
                              placeholder={t('e.g., INBOX/subfolder')}
                              disabled={isLoggingIn}
                            />
                          </FormField>

                          <View style={{ marginTop: 10 }}>
                            <ButtonWithLoading
                              variant="bare"
                              style={{ padding: '5px 10px', fontSize: 13 }}
                              onPress={handleTestImap}
                              isLoading={isTestingImap}
                              isDisabled={
                                isLoggingIn ||
                                !imapHost ||
                                !imapUser ||
                                !imapPassword
                              }
                            >
                              <Trans>Test IMAP Connection</Trans>
                            </ButtonWithLoading>

                            {imapTestResult && (
                              <Text
                                style={{
                                  marginTop: 8,
                                  fontSize: 13,
                                  color: imapTestResult.success
                                    ? theme.noticeTextLight
                                    : theme.errorText,
                                }}
                              >
                                {imapTestResult.success ? '✓ ' : '✗ '}
                                {imapTestResult.message}
                              </Text>
                            )}

                            {isDevelopmentEnvironment() && (
                              <>
                                <ButtonWithLoading
                                  variant="bare"
                                  style={{
                                    padding: '5px 10px',
                                    fontSize: 13,
                                    marginTop: 8,
                                  }}
                                  onPress={handleDebugImap}
                                  isLoading={isDebugging}
                                >
                                  <Trans>Debug: Check Recent Emails</Trans>
                                </ButtonWithLoading>

                                {debugResult && (
                                  <View
                                    style={{
                                      marginTop: 8,
                                      padding: 8,
                                      backgroundColor: theme.tableBackground,
                                      borderRadius: 4,
                                      maxHeight: 200,
                                      overflow: 'auto',
                                    }}
                                  >
                                    <Text
                                      style={{
                                        fontSize: 11,
                                        fontFamily: 'monospace',
                                        whiteSpace: 'pre-wrap',
                                      }}
                                    >
                                      {debugResult}
                                    </Text>
                                  </View>
                                )}
                              </>
                            )}
                          </View>
                        </View>
                      )}
                    </View>

                    {/* CAPTCHA Solver Configuration */}
                    <View style={{ marginTop: 15 }}>
                      <Button
                        variant="bare"
                        onPress={() => setShowCaptchaConfig(!showCaptchaConfig)}
                        style={{ padding: 0, fontSize: 13 }}
                      >
                        {showCaptchaConfig
                          ? t('▼ Hide CAPTCHA solver settings')
                          : t('▶ Configure CAPTCHA solver (optional)')}
                      </Button>

                      {showCaptchaConfig && (
                        <View
                          style={{
                            marginTop: 10,
                            padding: 10,
                            backgroundColor: theme.tableRowBackgroundHover,
                            borderRadius: 4,
                          }}
                        >
                          <Text style={{ fontSize: 13, marginBottom: 10 }}>
                            <Trans>
                              American Express may show a CAPTCHA challenge,
                              especially when accessing from datacenter IPs
                              (cloud servers, VPS). Configure a 2Captcha API key
                              to automatically solve these challenges.
                            </Trans>
                          </Text>

                          <Text
                            style={{
                              fontSize: 12,
                              marginBottom: 10,
                              color: theme.pageTextSubdued,
                            }}
                          >
                            <Trans>
                              Get an API key from 2captcha.com (~$3 per 1000
                              solves)
                            </Trans>
                          </Text>

                          {isCaptchaConfigured && (
                            <Text
                              style={{
                                fontSize: 12,
                                marginBottom: 10,
                                color: theme.noticeTextLight,
                              }}
                            >
                              ✓ <Trans>2Captcha is configured</Trans>
                            </Text>
                          )}

                          <FormField>
                            <FormLabel
                              title={t('2Captcha API Key')}
                              htmlFor="amex-captcha-key"
                            />
                            <Input
                              id="amex-captcha-key"
                              type="password"
                              value={captchaApiKey}
                              onChangeValue={setCaptchaApiKey}
                              placeholder={
                                isCaptchaConfigured
                                  ? t('Enter new key to update')
                                  : t('Enter your 2Captcha API key')
                              }
                              disabled={isLoggingIn}
                            />
                          </FormField>

                          <View style={{ marginTop: 10 }}>
                            <ButtonWithLoading
                              variant="bare"
                              style={{ padding: '5px 10px', fontSize: 13 }}
                              onPress={handleTestCaptcha}
                              isLoading={isTestingCaptcha}
                              isDisabled={isLoggingIn || !captchaApiKey}
                            >
                              <Trans>Test API Key</Trans>
                            </ButtonWithLoading>

                            {captchaTestResult && (
                              <Text
                                style={{
                                  marginTop: 8,
                                  fontSize: 13,
                                  color: captchaTestResult.success
                                    ? theme.noticeTextLight
                                    : theme.errorText,
                                }}
                              >
                                {captchaTestResult.success ? '✓ ' : '✗ '}
                                {captchaTestResult.message}
                              </Text>
                            )}
                          </View>
                        </View>
                      )}
                    </View>

                    {/* Proxy Configuration */}
                    <View style={{ marginTop: 15 }}>
                      <Button
                        variant="bare"
                        onPress={() => setShowProxyConfig(!showProxyConfig)}
                        style={{ padding: 0, fontSize: 13 }}
                      >
                        {showProxyConfig
                          ? t('▼ Hide proxy settings')
                          : t('▶ Configure proxy (optional)')}
                      </Button>

                      {showProxyConfig && (
                        <View
                          style={{
                            marginTop: 10,
                            padding: 10,
                            backgroundColor: theme.tableRowBackgroundHover,
                            borderRadius: 4,
                          }}
                        >
                          <Text style={{ fontSize: 13, marginBottom: 10 }}>
                            <Trans>
                              If you're running on a VPS or cloud server, Amex
                              may block or flag login attempts from datacenter
                              IP addresses. Configure a proxy to route browser
                              traffic through your home IP instead (e.g., via
                              WireGuard or Tailscale VPN with a SOCKS5 proxy).
                            </Trans>
                          </Text>

                          <Text
                            style={{
                              fontSize: 12,
                              marginBottom: 10,
                              color: theme.pageTextSubdued,
                            }}
                          >
                            <Trans>
                              Example: socks5://10.0.0.1:1080 (your home machine
                              running a SOCKS5 proxy over VPN)
                            </Trans>
                          </Text>

                          {isProxyConfigured && (
                            <Text
                              style={{
                                fontSize: 12,
                                marginBottom: 10,
                                color: theme.noticeTextLight,
                              }}
                            >
                              ✓ <Trans>Proxy is configured</Trans>
                            </Text>
                          )}

                          <FormField>
                            <FormLabel
                              title={t('Proxy URL')}
                              htmlFor="amex-proxy-url"
                            />
                            <Input
                              id="amex-proxy-url"
                              type="text"
                              value={proxyUrl}
                              onChangeValue={setProxyUrl}
                              placeholder={
                                isProxyConfigured
                                  ? t('Enter new URL to update')
                                  : t('socks5://host:port or http://host:port')
                              }
                              disabled={isLoggingIn}
                            />
                          </FormField>

                          <View style={{ marginTop: 10 }}>
                            <ButtonWithLoading
                              variant="bare"
                              style={{ padding: '5px 10px', fontSize: 13 }}
                              onPress={handleTestProxy}
                              isLoading={isTestingProxy}
                              isDisabled={isLoggingIn || !proxyUrl}
                            >
                              <Trans>Test Proxy</Trans>
                            </ButtonWithLoading>

                            {proxyTestResult && (
                              <Text
                                style={{
                                  marginTop: 8,
                                  fontSize: 13,
                                  color: proxyTestResult.success
                                    ? theme.noticeTextLight
                                    : theme.errorText,
                                }}
                              >
                                {proxyTestResult.success ? '✓ ' : '✗ '}
                                {proxyTestResult.message}
                              </Text>
                            )}
                          </View>
                        </View>
                      )}
                    </View>

                    {isLoggingIn ? (
                      <WaitingIndicator
                        message={t(
                          'Logging in to American Express. This may take a moment...',
                        )}
                      />
                    ) : (
                      <ButtonWithLoading
                        variant="primary"
                        style={{
                          padding: '10px 0',
                          fontSize: 15,
                          fontWeight: 600,
                          marginTop: 15,
                        }}
                        onPress={handleLogin}
                        isLoading={isLoggingIn}
                      >
                        <Trans>Log in</Trans>
                      </ButtonWithLoading>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <Paragraph style={{ fontSize: 15, marginBottom: 15 }}>
                  <Trans>
                    Successfully logged in! Found{' '}
                    {{ count: token.accounts.length }} account(s). Click
                    continue to select which accounts to link.
                  </Trans>
                </Paragraph>

                {token.accounts.length > 0 && (
                  <View
                    style={{
                      marginBottom: 15,
                      padding: 10,
                      backgroundColor: theme.tableRowBackgroundHover,
                      borderRadius: 4,
                    }}
                  >
                    <Text
                      style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}
                    >
                      <Trans>Available accounts:</Trans>
                    </Text>
                    {token.accounts.map((account, index) => (
                      <View
                        key={account.account_token}
                        style={{
                          padding: 8,
                          marginTop: index > 0 ? 6 : 0,
                          backgroundColor: theme.tableBackground,
                          borderRadius: 4,
                        }}
                      >
                        <Text style={{ fontSize: 14, fontWeight: 500 }}>
                          {account.name}
                        </Text>
                        <Text
                          style={{
                            fontSize: 12,
                            color: theme.pageTextSubdued,
                            marginTop: 2,
                          }}
                        >
                          ****{account.display_number}
                          {account.balance !== undefined &&
                            ` • Balance: €${account.balance.toLocaleString()}`}
                          {account.credit_limit &&
                            ` • Limit: €${account.credit_limit.toLocaleString()}`}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}

                <Button
                  variant="primary"
                  autoFocus
                  style={{
                    padding: '10px 0',
                    fontSize: 15,
                    fontWeight: 600,
                  }}
                  onPress={handleContinue}
                >
                  <Trans>Continue</Trans> &rarr;
                </Button>
              </>
            )}
          </View>
        </>
      )}
    </Modal>
  );
}
