---- MODULE CancellationSettlementActiveRejoinWitnesses ----
EXTENDS CancellationSettlement

ChosenWaiter == CHOOSE w \in Waiters : TRUE

ActiveRejoinNext ==
  IF phase = "open"
  THEN BeginClose(ChosenWaiter)
  ELSE IF waiterState[ChosenWaiter] = "waiting"
          /\ closeCount[ChosenWaiter] = 1
          /\ phase \in {"closing", "reconciliation_required"}
  THEN CancelWait(ChosenWaiter)
  ELSE IF waiterState[ChosenWaiter] = "cancelled"
          /\ closeCount[ChosenWaiter] = 1
          /\ phase \in {"closing", "reconciliation_required"}
  THEN JoinClose(ChosenWaiter)
  ELSE SafeNext

ActiveRejoinSpec == Init /\ [][ActiveRejoinNext]_vars

ActiveRejoinWitnessAbsent ==
  ~(phase \in {"closing", "reconciliation_required"}
    /\ waiterState[ChosenWaiter] = "waiting"
    /\ closeCount[ChosenWaiter] = 2)

=============================================================================
