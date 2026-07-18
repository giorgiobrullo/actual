import { send } from '@actual-app/core/platform/client/connection';
import type {
  AccountEntity,
  SyncServerAmexAccount,
} from '@actual-app/core/types/models';
import type { AmexToken } from '@actual-app/core/types/models/amex';

import { pushModal } from '#modals/modalsSlice';
import type { AppDispatch } from '#redux/store';

export async function deconfigureAmex() {
  await send('amex-configure', { username: null, password: null });
}

export function authorizeAmex(
  dispatch: AppDispatch,
  upgradingAccountId?: AccountEntity['id'],
) {
  dispatch(
    pushModal({
      modal: {
        name: 'amex-setup-account',
        options: {
          onSuccess: async (token: AmexToken) => {
            const externalAccounts: SyncServerAmexAccount[] =
              token.accounts.map(amexAccount => ({
                account_id: amexAccount.account_token,
                name: amexAccount.name,
                institution: 'American Express',
                balance: amexAccount.balance ?? 0,
                mask: amexAccount.display_number,
              }));

            dispatch(
              pushModal({
                modal: {
                  name: 'select-linked-accounts',
                  options: {
                    externalAccounts,
                    syncSource: 'amex',
                    upgradingAccountId,
                  },
                },
              }),
            );
          },
        },
      },
    }),
  );
}
