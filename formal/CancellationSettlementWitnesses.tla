---- MODULE CancellationSettlementWitnesses ----
EXTENDS CancellationSettlement

ChosenWaiter == CHOOSE w \in Waiters : TRUE
ChosenChild == CHOOSE c \in Children : TRUE
OtherChild == CHOOSE c \in Children \ {ChosenChild} : TRUE

PreCloseSuccessNext ==
  IF phase = "open" /\ \A c \in Children : childState[c] = "pending"
  THEN SettleChildSuccess(ChosenChild)
  ELSE IF phase = "open"
  THEN BeginClose(ChosenWaiter)
  ELSE IF phase \in {"closing", "reconciliation_required"}
          /\ childState[OtherChild] = "pending"
  THEN SettleChildFailure(OtherChild)
  ELSE SafeNext

PreCloseSuccessSpec == Init /\ [][PreCloseSuccessNext]_vars

PreCloseSuccessFailureWitnessAbsent ==
  ~(phase = "settled_failure" /\ visibleSuccesses # {})

PreCloseFailureNext ==
  IF phase = "open" /\ \A c \in Children : childState[c] = "pending"
  THEN SettleChildFailure(ChosenChild)
  ELSE IF phase = "open"
  THEN BeginClose(ChosenWaiter)
  ELSE SafeNext

PreCloseFailureSpec == Init /\ [][PreCloseFailureNext]_vars

PreCloseFailureReconciliationWitnessAbsent ==
  ~(phase = "reconciliation_required")

RepeatedCloseNext ==
  IF phase = "open"
  THEN BeginClose(ChosenWaiter)
  ELSE SafeNext

RepeatedCloseSpec == Init /\ [][RepeatedCloseNext]_vars

RepeatedCloseWitnessAbsent == ~(closeCount[ChosenWaiter] = 2)

CancelledRetryNext ==
  IF phase = "open"
  THEN BeginClose(ChosenWaiter)
  ELSE IF waiterState[ChosenWaiter] = "waiting"
  THEN CancelWait(ChosenWaiter)
  ELSE SafeNext

CancelledRetrySpec == Init /\ [][CancelledRetryNext]_vars

CancelledRetryWitnessAbsent ==
  ~(closeCount[ChosenWaiter] = 2
    /\ waiterState[ChosenWaiter] \in {"observed_success", "observed_failure"})

=============================================================================
