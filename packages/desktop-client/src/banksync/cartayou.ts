import { send } from 'loot-core/platform/client/fetch';
import {
  type AccountEntity,
  type SyncServerGoCardlessAccount,
} from 'loot-core/types/models';
import { type CartaYouToken } from 'loot-core/types/models/cartayou';

import { linkAccount } from '@desktop-client/accounts/accountsSlice';
import { closeModal, pushModal } from '@desktop-client/modals/modalsSlice';
import { addNotification } from '@desktop-client/notifications/notificationsSlice';
import { type AppDispatch } from '@desktop-client/redux/store';

export async function deconfigureCartaYou() {
  await send('cartayou-deconfigure');
}

export function selectCartaYouAccounts(
  dispatch: AppDispatch,
  token: CartaYouToken,
  accountEntity?: AccountEntity,
) {
  // Converting Carta You accounts to "GoCardlessAccounts" format for compatibility
  const accounts: SyncServerGoCardlessAccount[] = token.accounts.map(
    cartayouAccount => ({
      account_id: cartayouAccount.account_id,
      name: cartayouAccount.name,
      institution: { name: 'Carta You (Advanzia)' },
      mask: cartayouAccount.display_number,
      official_name: cartayouAccount.name,
      balance: cartayouAccount.balance ?? 0,
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
          requisitionId: 'cartayou',
          upgradingId: accountEntity.id,
          syncSource: 'cartayou',
        }),
      );
      dispatch(
        addNotification({
          notification: {
            type: 'message',
            message: `Reauthorized Banksync via Carta You for ${accountEntity.name}`,
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
          requisitionId: 'cartayou',
          externalAccounts: accounts,
          syncSource: 'cartayou',
        },
      },
    }),
  );
}

export function authorizeCartaYouSession(
  dispatch: AppDispatch,
  account?: AccountEntity,
  onUnlink?: () => void,
) {
  dispatch(
    pushModal({
      modal: {
        name: 'cartayou-setup-account',
        options: {
          onSuccess: async (token: CartaYouToken) => {
            if (onUnlink) {
              onUnlink();
            }
            selectCartaYouAccounts(dispatch, token, account);
          },
        },
      },
    }),
  );
}
