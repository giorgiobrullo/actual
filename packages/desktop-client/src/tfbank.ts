import { send } from '@actual-app/core/platform/client/connection';
import type {
  AccountEntity,
  SyncServerTFBankAccount,
} from '@actual-app/core/types/models';
import type { TFBankToken } from '@actual-app/core/types/models/tfbank';

import { pushModal } from '#modals/modalsSlice';
import type { AppDispatch } from '#redux/store';

export async function deconfigureTFBank() {
  await send('tfbank-deconfigure');
}

export function authorizeTFBank(
  dispatch: AppDispatch,
  upgradingAccountId?: AccountEntity['id'],
) {
  dispatch(
    pushModal({
      modal: {
        name: 'tfbank-setup-account',
        options: {
          onSuccess: async (token: TFBankToken) => {
            const externalAccounts: SyncServerTFBankAccount[] =
              token.accounts.map(tfBankAccount => ({
                account_id: tfBankAccount.account_id,
                name: tfBankAccount.name,
                institution: 'TF Bank',
                balance: tfBankAccount.balance ?? 0,
                mask: tfBankAccount.display_number,
              }));

            dispatch(
              pushModal({
                modal: {
                  name: 'select-linked-accounts',
                  options: {
                    externalAccounts,
                    syncSource: 'tfbank',
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
