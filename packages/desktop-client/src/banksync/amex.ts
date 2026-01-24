import { send } from 'loot-core/platform/client/fetch';
import {
  type AccountEntity,
  type SyncServerGoCardlessAccount,
} from 'loot-core/types/models';
import { type AmexToken } from 'loot-core/types/models/amex';

import { linkAccount } from '@desktop-client/accounts/accountsSlice';
import { closeModal, pushModal } from '@desktop-client/modals/modalsSlice';
import { addNotification } from '@desktop-client/notifications/notificationsSlice';
import { type AppDispatch } from '@desktop-client/redux/store';

export async function deconfigureAmex() {
  await send('amex-configure', { username: null, password: null });
}

export function selectAmexAccounts(
  dispatch: AppDispatch,
  token: AmexToken,
  accountEntity?: AccountEntity,
) {
  // Converting Amex accounts to "GoCardlessAccounts" format for compatibility
  const accounts: SyncServerGoCardlessAccount[] = token.accounts.map(
    amexAccount => ({
      account_id: amexAccount.account_token,
      name: amexAccount.name,
      institution: { name: 'American Express' },
      mask: amexAccount.display_number,
      official_name: amexAccount.name,
      balance: amexAccount.balance,
    }),
  );

  if (accountEntity && accountEntity.official_name) {
    // Find appropriate account
    const account = accounts
      .filter(
        tokenAccount =>
          tokenAccount.official_name === accountEntity.official_name,
      )
      .at(0);
    if (account) {
      dispatch(
        linkAccount({
          account,
          requisitionId: 'amex',
          upgradingId: accountEntity.id,
          syncSource: 'amex',
        }),
      );
      dispatch(
        addNotification({
          notification: {
            type: 'message',
            message: `Reauthorized Banksync via Amex for ${accountEntity.name}`,
          },
        }),
      );
      dispatch(closeModal());
      return;
    }
  }

  dispatch(
    pushModal({
      modal: {
        name: 'select-linked-accounts',
        options: {
          requisitionId: 'amex',
          externalAccounts: accounts,
          syncSource: 'amex',
        },
      },
    }),
  );
}

export function authorizeAmexSession(
  dispatch: AppDispatch,
  account?: AccountEntity,
  onUnlink?: () => void,
) {
  dispatch(
    pushModal({
      modal: {
        name: 'amex-setup-account',
        options: {
          onSuccess: async (token: AmexToken) => {
            if (onUnlink) {
              onUnlink();
            }
            selectAmexAccounts(dispatch, token, account);
          },
        },
      },
    }),
  );
}
