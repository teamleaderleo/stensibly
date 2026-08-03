---- MODULE CancellationSettlementActive ----
EXTENDS CancellationSettlement

RejoinClose(w) ==
  /\ phase \in {"closing", "reconciliation_required"}
  /\ waiterState[w] = "cancelled"
  /\ closeCount[w] = 1
  /\ waiterState' = [waiterState EXCEPT ![w] = "waiting"]
  /\ closeCount' = [closeCount EXCEPT ![w] = 2]
  /\ UNCHANGED <<
       phase,
       authorityCount,
       acceptingNewWork,
       childState,
       visibleSuccesses,
       terminalResult,
       oldCanPublish,
       fenceActive,
       replacementAdmitted,
       staleEffectAccepted,
       newWorkCount,
       lastObservedResult,
       repeatedResultMismatch
     >>

BoundedCancelWait(w) ==
  /\ closeCount[w] < 2
  /\ CancelWait(w)

ActiveSafeNext ==
  \/ \E w \in Waiters : BeginClose(w)
  \/ \E w \in Waiters : JoinClose(w)
  \/ \E w \in Waiters : BoundedCancelWait(w)
  \/ \E w \in Waiters : RejoinClose(w)
  \/ \E c \in Children : SettleChildSuccess(c)
  \/ \E c \in Children : SettleChildFailure(c)
  \/ MarkReconciliation
  \/ FinishSuccess
  \/ FinishFailure
  \/ FencePriorGeneration
  \/ AdmitReplacement
  \/ PriorGenerationPublishes
  \/ \E w \in Waiters : ObserveTerminal(w)
  \/ AdmitNewWork

ActiveSpec == Init /\ [][ActiveSafeNext]_vars

CancelledWaiterHasRetryCapacity ==
  \A w \in Waiters :
    waiterState[w] = "cancelled" => closeCount[w] < 2

=============================================================================
