---- MODULE CancellationSettlementActiveRejoinWitnesses ----
EXTENDS CancellationSettlementActive

ChosenWaiter == CHOOSE w \in Waiters : TRUE

PendingChildren == {c \in Children : childState[c] = "pending"}
ChosenPendingChild == CHOOSE c \in PendingChildren : TRUE

ActiveRejoinNext ==
  IF phase = "open"
  THEN BeginClose(ChosenWaiter)
  ELSE IF waiterState[ChosenWaiter] = "waiting"
          /\ closeCount[ChosenWaiter] = 1
          /\ phase \in {"closing", "reconciliation_required"}
  THEN BoundedCancelWait(ChosenWaiter)
  ELSE IF waiterState[ChosenWaiter] = "cancelled"
          /\ closeCount[ChosenWaiter] = 1
          /\ phase \in {"closing", "reconciliation_required"}
  THEN RejoinClose(ChosenWaiter)
  ELSE IF waiterState[ChosenWaiter] = "waiting"
          /\ closeCount[ChosenWaiter] = 2
          /\ phase \in {"closing", "reconciliation_required"}
          /\ PendingChildren # {}
  THEN SettleChildSuccess(ChosenPendingChild)
  ELSE IF waiterState[ChosenWaiter] = "waiting"
          /\ closeCount[ChosenWaiter] = 2
          /\ phase \in {"closing", "reconciliation_required"}
          /\ \A c \in Children : childState[c] = "success"
  THEN FinishSuccess
  ELSE ActiveSafeNext

ActiveRejoinSpec == Init /\ [][ActiveRejoinNext]_vars

ActiveRejoinWitnessAbsent ==
  ~(phase = "settled_success"
    /\ waiterState[ChosenWaiter] = "observed_success"
    /\ closeCount[ChosenWaiter] = 2
    /\ lastObservedResult[ChosenWaiter] = "success")

=============================================================================
