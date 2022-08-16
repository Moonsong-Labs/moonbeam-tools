// List of functions to simplify supporting multiple version

export interface DelegatorRequest {
  delegatorId: string;
  collatorId: string;
  when: number;
  action: "Revoke" | "Decrease";
  amount: bigint;
}

// Compute the staking request per delegator (faster that search each time)
// This part has changed in runtime version 1500
export const combineRequestsPerDelegators = (
  specVersion: number,
  delegationScheduledRequests: any,
  delegatorState: any
): { [delegatorId: string]: DelegatorRequest[] } => {
  return specVersion >= 1500
    ? delegationScheduledRequests.reduce((p, collatorRequests) => {
        const collatorId = `0x${collatorRequests[0].toHex().slice(-40)}`;
        (collatorRequests[1] as any).forEach((request) => {
          const delegatorId = request.delegator.toHex() as string;
          if (!p[delegatorId]) {
            p[delegatorId] = [];
          }
          p[delegatorId].push({
            delegatorId,
            collatorId,
            when: request.whenExecutable.toNumber(),
            action: request.action.isRevoke ? "Revoke" : "Decrease",
            amount: request.action.isRevoke
              ? request.action.asRevoke.toBigInt()
              : request.action.asDecrease.toBigInt(),
          } as DelegatorRequest);
        });
        return p;
      }, {})
    : delegatorState.reduce((p, state) => {
        const stateData = state[1].unwrap();
        const delegatorId = stateData.id.toHex();
        if (!p[delegatorId]) {
          p[delegatorId] = [];
        }
        for (const requestData of stateData.requests.requests) {
          const request = requestData[1];
          const collatorId = request.collator.toHex();

          p[delegatorId].push({
            delegatorId,
            collatorId,
            when: request.whenExecutable.toNumber(),
            action: request.action.isRevoke ? "Revoke" : "Decrease",
            amount: request.amount.toBigInt(),
          } as DelegatorRequest);
        }

        return p;
      }, {});
};
