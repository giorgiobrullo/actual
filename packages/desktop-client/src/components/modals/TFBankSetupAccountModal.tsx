import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { AnimatedLoading } from '@actual-app/components/icons/AnimatedLoading';
import { SvgCheveronDown } from '@actual-app/components/icons/v1';
import { Input } from '@actual-app/components/input';
import { Paragraph } from '@actual-app/components/paragraph';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import type {
  TFBankErrorCode,
  TFBankErrorInterface,
  TFBankToken,
} from '@actual-app/core/types/models/tfbank';

import { Error, Warning } from '#components/alerts';
import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { FormField, FormLabel } from '#components/forms';
import { useServerURL } from '#components/ServerContext';
import type { Modal as ModalType } from '#modals/modalsSlice';

function renderError(
  error: TFBankErrorInterface,
  t: ReturnType<typeof useTranslation>['t'],
) {
  const error_messages: Partial<Record<TFBankErrorCode, string>> = {
    TIMED_OUT: t('Timed out. Please try again.'),
    TFBANK_NOT_CONFIGURED: t(
      'TF Bank is not configured. Please enter your credentials.',
    ),
    AUTH_FAILED: t(
      'Authentication failed. Please check your email and password.',
    ),
    SMS_2FA_REQUIRED: t(
      'SMS verification is required. Please check your phone for the code.',
    ),
    TFBANK_SESSION_EXPIRED: t('Session expired. Please try again.'),
    INTERNAL_ERROR: t('An internal error occurred. Please try again.'),
  };

  return (
    <Error style={{ alignSelf: 'center', marginBottom: 10 }}>
      {error.error_code in error_messages
        ? error_messages[error.error_code]
        : t('An error occurred while linking your account: {{ message }}', {
            message: error.error_type,
          })}
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

const CopyButton = ({ text, label }: { text: string; label: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      variant="bare"
      style={{ fontSize: 12, padding: '4px 8px' }}
      onPress={handleCopy}
    >
      {copied ? '✓ Copied!' : label}
    </Button>
  );
};

type TFBankSetupAccountModalProps = Extract<
  ModalType,
  { name: 'tfbank-setup-account' }
>['options'];

export function TFBankSetupAccountModal({
  onSuccess,
}: TFBankSetupAccountModalProps) {
  const { t } = useTranslation();
  const serverURL = useServerURL();

  const [error, setError] = useState<TFBankErrorInterface | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [token, setToken] = useState<TFBankToken | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);
  const [isConfigured, setIsConfigured] = useState(false);
  const [showNewCredentials, setShowNewCredentials] = useState(false);

  // SMS setup state
  const [showSmsSetup, setShowSmsSetup] = useState(false);
  const [smsSecret, setSmsSecret] = useState<string | null>(null);
  const [isSmsConfigured, setIsSmsConfigured] = useState(false);
  const [isGeneratingSecret, setIsGeneratingSecret] = useState(false);

  const webhookUrl = serverURL ? `${serverURL}/tfbank/sms-webhook` : '';

  // Check if credentials and SMS are already configured on mount
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const [credResult, smsResult] = await Promise.all([
          send('tfbank-status'),
          send('tfbank-sms-status'),
        ]);

        if (credResult?.data?.configured) {
          setIsConfigured(true);
        }
        if (smsResult?.data?.configured) {
          setIsSmsConfigured(true);
        }
      } catch {
        // Ignore errors, just show the form
      } finally {
        setIsCheckingStatus(false);
      }
    };
    void checkStatus();
  }, []);

  const handleGenerateSecret = async () => {
    setIsGeneratingSecret(true);
    try {
      const result = await send('tfbank-sms-setup');
      if (result?.data?.secret) {
        setSmsSecret(result.data.secret);
        setIsSmsConfigured(true);
      }
    } catch (err) {
      setError({
        error_code: 'INTERNAL_ERROR',
        error_type: String(err),
      });
    } finally {
      setIsGeneratingSecret(false);
    }
  };

  // Login with saved credentials (no need to re-enter)
  const handleLoginWithSaved = async () => {
    setError(null);
    setIsLoggingIn(true);

    try {
      const loginResult = await send('tfbank-login');
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
        error_type: t('Please enter both email and password.'),
      });
      return;
    }

    setError(null);
    setIsLoggingIn(true);

    try {
      // First configure the credentials
      const configResult = await send('tfbank-configure', {
        username,
        password,
      });
      if (configResult?.error) {
        setError(configResult.error);
        setIsLoggingIn(false);
        return;
      }

      // Then attempt login
      const loginResult = await send('tfbank-login');
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
      name="tfbank-setup-account"
      containerProps={{
        style: { width: '40vw', minWidth: 450, maxWidth: 600 },
      }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Link TF Bank')}
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
                        Your TF Bank credentials are already configured. Click
                        below to log in and discover your accounts.
                      </Trans>
                    </Paragraph>

                    {isLoggingIn ? (
                      <WaitingIndicator
                        message={t(
                          'Logging in to TF Bank. This may take a moment...',
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
                        Enter your TF Bank credentials. Your credentials will be
                        stored securely on your server and used to sync
                        transactions.
                      </Trans>
                    </Paragraph>

                    <Warning style={{ marginBottom: 15 }}>
                      <Trans>
                        This feature logs in to your TF Bank account through the
                        bank&apos;s API. Your credentials are stored on your
                        sync server. Only use this if you trust your server
                        environment.
                      </Trans>
                    </Warning>

                    <FormField>
                      <FormLabel title={t('Email')} htmlFor="tfbank-username" />
                      <Input
                        id="tfbank-username"
                        type="email"
                        value={username}
                        onChangeValue={setUsername}
                        placeholder={t('Enter your TF Bank email')}
                        disabled={isLoggingIn}
                      />
                    </FormField>

                    <FormField style={{ marginTop: 10 }}>
                      <FormLabel
                        title={t('Password')}
                        htmlFor="tfbank-password"
                      />
                      <Input
                        id="tfbank-password"
                        type="password"
                        value={password}
                        onChangeValue={setPassword}
                        placeholder={t('Enter your TF Bank password')}
                        disabled={isLoggingIn}
                      />
                    </FormField>

                    {/* iOS-only notice before SMS Setup */}
                    <Text
                      style={{
                        fontSize: 13,
                        marginTop: 20,
                        marginBottom: 12,
                      }}
                    >
                      <Trans>
                        <strong>iOS only.</strong> Your iPhone must be on and
                        connected to the internet when syncing, or the sync will
                        be skipped.
                      </Trans>
                    </Text>

                    {/* SMS Setup Section - Required, after credentials */}
                    <View
                      style={{
                        border: `1px solid ${theme.tableBorder}`,
                        borderRadius: 6,
                        overflow: 'hidden',
                      }}
                    >
                      <Button
                        variant="bare"
                        style={{
                          width: '100%',
                          padding: 12,
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          backgroundColor: theme.tableRowBackgroundHover,
                        }}
                        onPress={() => setShowSmsSetup(!showSmsSetup)}
                      >
                        <View
                          style={{ flexDirection: 'row', alignItems: 'center' }}
                        >
                          <Text style={{ fontWeight: 600, fontSize: 14 }}>
                            <Trans>SMS Verification Setup</Trans>
                          </Text>
                          <Text
                            style={{
                              marginLeft: 8,
                              fontSize: 12,
                              color: isSmsConfigured
                                ? theme.noticeTextLight
                                : theme.errorText,
                              backgroundColor: isSmsConfigured
                                ? theme.noticeBackground
                                : theme.errorBackground,
                              padding: '2px 6px',
                              borderRadius: 4,
                            }}
                          >
                            {isSmsConfigured ? (
                              <Trans>Configured</Trans>
                            ) : (
                              <Trans>Required</Trans>
                            )}
                          </Text>
                        </View>
                        <SvgCheveronDown
                          style={{
                            width: 16,
                            height: 16,
                            transform: showSmsSetup
                              ? 'rotate(180deg)'
                              : 'rotate(0deg)',
                            transition: 'transform 0.2s',
                          }}
                        />
                      </Button>

                      {showSmsSetup && (
                        <View style={{ padding: 12 }}>
                          <Text
                            style={{
                              fontSize: 13,
                              marginBottom: 12,
                            }}
                          >
                            <Trans>
                              TF Bank requires SMS verification. Set up
                              automatic SMS forwarding from your iPhone to
                              receive codes automatically during sync.
                            </Trans>
                          </Text>

                          {/* Step 1: Generate Secret */}
                          <View style={{ marginBottom: 16 }}>
                            <Text
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                marginBottom: 8,
                              }}
                            >
                              1. {t('Generate Webhook Secret')}
                            </Text>

                            {smsSecret ? (
                              <View
                                style={{
                                  padding: 10,
                                  backgroundColor: theme.tableBackground,
                                  borderRadius: 4,
                                  marginBottom: 8,
                                }}
                              >
                                <View
                                  style={{
                                    flexDirection: 'row',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                  }}
                                >
                                  <Text
                                    style={{
                                      fontFamily: 'monospace',
                                      fontSize: 11,
                                      wordBreak: 'break-all',
                                      flex: 1,
                                      marginRight: 8,
                                    }}
                                  >
                                    {smsSecret}
                                  </Text>
                                  <CopyButton
                                    text={smsSecret}
                                    label={t('Copy')}
                                  />
                                </View>
                              </View>
                            ) : isSmsConfigured ? (
                              <Text
                                style={{
                                  fontSize: 12,
                                  marginBottom: 8,
                                }}
                              >
                                <Trans>
                                  Secret already configured. Generate a new one
                                  if needed.
                                </Trans>
                              </Text>
                            ) : null}

                            <Button
                              variant="bare"
                              style={{ fontSize: 13 }}
                              onPress={handleGenerateSecret}
                              isDisabled={isGeneratingSecret}
                            >
                              {isGeneratingSecret
                                ? t('Generating...')
                                : smsSecret || isSmsConfigured
                                  ? t('Regenerate Secret')
                                  : t('Generate Secret')}
                            </Button>
                          </View>

                          {/* Step 2: Webhook URL */}
                          <View style={{ marginBottom: 16 }}>
                            <Text
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                marginBottom: 8,
                              }}
                            >
                              2. {t('Webhook URL')}
                            </Text>
                            <View
                              style={{
                                padding: 10,
                                backgroundColor: theme.tableBackground,
                                borderRadius: 4,
                                flexDirection: 'row',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                              }}
                            >
                              <Text
                                style={{
                                  fontFamily: 'monospace',
                                  fontSize: 11,
                                  wordBreak: 'break-all',
                                  flex: 1,
                                  marginRight: 8,
                                }}
                              >
                                {webhookUrl}
                              </Text>
                              <CopyButton text={webhookUrl} label={t('Copy')} />
                            </View>
                          </View>

                          {/* Step 3: iOS Shortcut Setup */}
                          <View>
                            <Text
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                marginBottom: 8,
                              }}
                            >
                              3. {t('Create iOS Shortcut')}
                            </Text>
                            <View
                              style={{
                                fontSize: 12,
                                backgroundColor: theme.tableBackground,
                                padding: 10,
                                borderRadius: 4,
                              }}
                            >
                              <Text style={{ fontSize: 12, marginBottom: 8 }}>
                                <Trans>
                                  Create a Shortcut with these steps:
                                </Trans>
                              </Text>
                              <Text
                                style={{
                                  fontSize: 12,
                                  fontFamily: 'monospace',
                                  whiteSpace: 'pre-wrap',
                                }}
                              >
                                {`Repeat 3 times
  Get Contents of URL
    URL: ${webhookUrl}
    Method: POST
    Request Body: JSON
    {
      "body": [Shortcut Input],
      "secret": "${smsSecret || '<your-secret>'}"
    }
  If [Contents of URL] has any value
    Stop this Shortcut
  End If
  Wait 2 seconds
End Repeat`}
                              </Text>
                            </View>

                            <Text
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                marginTop: 16,
                                marginBottom: 8,
                              }}
                            >
                              4. {t('Create iOS Automation')}
                            </Text>
                            <View
                              style={{
                                fontSize: 12,
                                backgroundColor: theme.tableBackground,
                                padding: 10,
                                borderRadius: 4,
                              }}
                            >
                              <Text
                                style={{
                                  fontSize: 12,
                                  fontFamily: 'monospace',
                                  whiteSpace: 'pre-wrap',
                                }}
                              >
                                {`Settings > Shortcuts > Automations
> New Automation
> Trigger: Message
> Message Contains: "codice di accesso"
> Run Immediately: ON
> Run Shortcut: [your shortcut]`}
                              </Text>
                            </View>
                          </View>
                        </View>
                      )}
                    </View>

                    {isLoggingIn ? (
                      <WaitingIndicator
                        message={t(
                          'Logging in to TF Bank. This may take a moment...',
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
                        isDisabled={!isSmsConfigured}
                      >
                        <Trans>Log in</Trans>
                      </ButtonWithLoading>
                    )}

                    {!isSmsConfigured && (
                      <Text
                        style={{
                          fontSize: 12,
                          marginTop: 8,
                          textAlign: 'center',
                        }}
                      >
                        <Trans>
                          Complete SMS setup above before logging in
                        </Trans>
                      </Text>
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
                        key={account.account_id}
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
                            marginTop: 2,
                          }}
                        >
                          ****{account.display_number}
                          {account.balance !== undefined &&
                            ` - Balance: ${account.balance.toLocaleString()}`}
                          {account.credit_limit &&
                            ` - Limit: ${account.credit_limit.toLocaleString()}`}
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
