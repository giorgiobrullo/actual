import { send } from '@actual-app/core/platform/client/connection';
import type {
  AccountEntity,
  SyncServerCartaYouAccount,
} from '@actual-app/core/types/models';
import type { CartaYouToken } from '@actual-app/core/types/models/cartayou';

import { pushModal } from '#modals/modalsSlice';
import type { AppDispatch } from '#redux/store';

export async function deconfigureCartaYou() {
  await send('cartayou-deconfigure');
}

export function authorizeCartaYou(
  dispatch: AppDispatch,
  upgradingAccountId?: AccountEntity['id'],
) {
  dispatch(
    pushModal({
      modal: {
        name: 'cartayou-setup-account',
        options: {
          onSuccess: async (token: CartaYouToken) => {
            const externalAccounts: SyncServerCartaYouAccount[] =
              token.accounts.map(cartaYouAccount => ({
                account_id: cartaYouAccount.account_id,
                name: cartaYouAccount.name,
                institution: 'Carta You (Advanzia)',
                balance: cartaYouAccount.balance ?? 0,
                mask: cartaYouAccount.display_number,
              }));

            dispatch(
              pushModal({
                modal: {
                  name: 'select-linked-accounts',
                  options: {
                    externalAccounts,
                    syncSource: 'cartayou',
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
