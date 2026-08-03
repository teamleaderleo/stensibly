---- MODULE CancellationSettlement ----
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Waiters, Children

Phases == {
  "open",
  "closing",
  "reconciliation_required",
  "settled_success",
  "settled_failure"
}

TerminalPhases == {"settled_success", "settled_failure"}
WaiterStates == {
  "idle",
  "waiting",
  "cancelled",
  "observed_success",
  "observed_failure"
}
ChildStates == {"pending", "success", "failure"}
TerminalResults == {"none", "success", "failure"}

VARIABLES
  phase,
  authorityCount,
  acceptingNewWork,
  waiterState,
  childState,
  visibleSuccesses,
  terminalResult,
  oldCanPublish,
  fenceActive,
  replacementAdmitted,
  staleEffectAccepted,
  newWorkCount,
  closeCount,
  lastObservedResult,
  repeatedResultMismatch

vars == <<
  phase,
  authorityCount,
  acceptingNewWork,
  waiterState,
  childState,
  visibleSuccesses,
  terminalResult,
  oldCanPublish,
  fenceActive,
  replacementAdmitted,
  staleEffectAccepted,
  newWorkCount,
  closeCount,
  lastObservedResult,
  repeatedResultMismatch
>>

Init ==
  /\ phase = "open"
  /\ authorityCount = 0
  /\ acceptingNewWork = TRUE
  /\ waiterState = [w \in Waiters |-> "idle"]
  /\ childState = [c \in Children |-> "pending"]
  /\ visibleSuccesses = {}
  /\ terminalResult = "none"
  /\ oldCanPublish = TRUE
  /\ fenceActive = FALSE
  /\ replacementAdmitted = FALSE
  /\ staleEffectAccepted = FALSE
  /\ newWorkCount = 0
  /\ closeCount = [w \in Waiters |-> 0]
  /\ lastObservedResult = [w \in Waiters |-> "none"]
  /\ repeatedResultMismatch = FALSE

BeginClose(w) ==
  /\ phase = "open"
  /\ waiterState[w] = "idle"
  /\ closeCount[w] = 0
  /\ phase' = "closing"
  /\ authorityCount' = 1
  /\ acceptingNewWork' = FALSE
  /\ waiterState' = [waiterState EXCEPT ![w] = "waiting"]
  /\ closeCount' = [closeCount EXCEPT ![w] = 1]
  /\ UNCHANGED <<
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

JoinClose(w) ==
  /\ phase \in {"closing", "reconciliation_required"}
  /\ waiterState[w] = "idle"
  /\ closeCount[w] = 0
  /\ waiterState' = [waiterState EXCEPT ![w] = "waiting"]
  /\ closeCount' = [closeCount EXCEPT ![w] = 1]
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

CancelWait(w) ==
  /\ waiterState[w] = "waiting"
  /\ waiterState' = [waiterState EXCEPT ![w] = "cancelled"]
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
       closeCount,
       lastObservedResult,
       repeatedResultMismatch
     >>

SettleChildSuccess(c) ==
  /\ phase \in {"open", "closing", "reconciliation_required"}
  /\ childState[c] = "pending"
  /\ childState' = [childState EXCEPT ![c] = "success"]
  /\ visibleSuccesses' = visibleSuccesses \cup {c}
  /\ UNCHANGED <<
       phase,
       authorityCount,
       acceptingNewWork,
       waiterState,
       terminalResult,
       oldCanPublish,
       fenceActive,
       replacementAdmitted,
       staleEffectAccepted,
       newWorkCount,
       closeCount,
       lastObservedResult,
       repeatedResultMismatch
     >>

SettleChildFailure(c) ==
  /\ phase \in {"open", "closing", "reconciliation_required"}
  /\ childState[c] = "pending"
  /\ childState' = [childState EXCEPT ![c] = "failure"]
  /\ UNCHANGED <<
       phase,
       authorityCount,
       acceptingNewWork,
       waiterState,
       visibleSuccesses,
       terminalResult,
       oldCanPublish,
       fenceActive,
       replacementAdmitted,
       staleEffectAccepted,
       newWorkCount,
       closeCount,
       lastObservedResult,
       repeatedResultMismatch
     >>

MarkReconciliation ==
  /\ phase = "closing"
  /\ \E c \in Children : childState[c] = "failure"
  /\ \E c \in Children : childState[c] = "pending"
  /\ phase' = "reconciliation_required"
  /\ UNCHANGED <<
       authorityCount,
       acceptingNewWork,
       waiterState,
       childState,
       visibleSuccesses,
       terminalResult,
       oldCanPublish,
       fenceActive,
       replacementAdmitted,
       staleEffectAccepted,
       newWorkCount,
       closeCount,
       lastObservedResult,
       repeatedResultMismatch
     >>

FinishSuccess ==
  /\ phase \in {"closing", "reconciliation_required"}
  /\ \A c \in Children : childState[c] = "success"
  /\ phase' = "settled_success"
  /\ terminalResult' = "success"
  /\ oldCanPublish' = FALSE
  /\ waiterState' = [w \in Waiters |->
       IF waiterState[w] = "waiting"
       THEN "observed_success"
       ELSE waiterState[w]]
  /\ lastObservedResult' = [w \in Waiters |->
       IF waiterState[w] = "waiting"
       THEN "success"
       ELSE lastObservedResult[w]]
  /\ UNCHANGED <<
       authorityCount,
       acceptingNewWork,
       childState,
       visibleSuccesses,
       fenceActive,
       replacementAdmitted,
       staleEffectAccepted,
       newWorkCount,
       closeCount,
       repeatedResultMismatch
     >>

FinishFailure ==
  /\ phase \in {"closing", "reconciliation_required"}
  /\ \A c \in Children : childState[c] # "pending"
  /\ \E c \in Children : childState[c] = "failure"
  /\ phase' = "settled_failure"
  /\ terminalResult' = "failure"
  /\ oldCanPublish' = FALSE
  /\ waiterState' = [w \in Waiters |->
       IF waiterState[w] = "waiting"
       THEN "observed_failure"
       ELSE waiterState[w]]
  /\ lastObservedResult' = [w \in Waiters |->
       IF waiterState[w] = "waiting"
       THEN "failure"
       ELSE lastObservedResult[w]]
  /\ UNCHANGED <<
       authorityCount,
       acceptingNewWork,
       childState,
       visibleSuccesses,
       fenceActive,
       replacementAdmitted,
       staleEffectAccepted,
       newWorkCount,
       closeCount,
       repeatedResultMismatch
     >>

FencePriorGeneration ==
  /\ phase \in {"closing", "reconciliation_required"}
  /\ oldCanPublish
  /\ fenceActive' = TRUE
  /\ oldCanPublish' = FALSE
  /\ UNCHANGED <<
       phase,
       authorityCount,
       acceptingNewWork,
       waiterState,
       childState,
       visibleSuccesses,
       terminalResult,
       replacementAdmitted,
       staleEffectAccepted,
       newWorkCount,
       closeCount,
       lastObservedResult,
       repeatedResultMismatch
     >>

AdmitReplacement ==
  /\ ~replacementAdmitted
  /\ ~oldCanPublish
  /\ replacementAdmitted' = TRUE
  /\ UNCHANGED <<
       phase,
       authorityCount,
       acceptingNewWork,
       waiterState,
       childState,
       visibleSuccesses,
       terminalResult,
       oldCanPublish,
       fenceActive,
       staleEffectAccepted,
       newWorkCount,
       closeCount,
       lastObservedResult,
       repeatedResultMismatch
     >>

UnsafeAdmitReplacement ==
  /\ ~replacementAdmitted
  /\ phase # "open"
  /\ replacementAdmitted' = TRUE
  /\ UNCHANGED <<
       phase,
       authorityCount,
       acceptingNewWork,
       waiterState,
       childState,
       visibleSuccesses,
       terminalResult,
       oldCanPublish,
       fenceActive,
       staleEffectAccepted,
       newWorkCount,
       closeCount,
       lastObservedResult,
       repeatedResultMismatch
     >>

PriorGenerationPublishes ==
  /\ oldCanPublish
  /\ staleEffectAccepted' = (staleEffectAccepted \/ replacementAdmitted)
  /\ UNCHANGED <<
       phase,
       authorityCount,
       acceptingNewWork,
       waiterState,
       childState,
       visibleSuccesses,
       terminalResult,
       oldCanPublish,
       fenceActive,
       replacementAdmitted,
       newWorkCount,
       closeCount,
       lastObservedResult,
       repeatedResultMismatch
     >>

ObserveTerminal(w) ==
  /\ phase \in TerminalPhases
  /\ closeCount[w] < 2
  /\ waiterState[w] \in {
       "idle",
       "cancelled",
       "observed_success",
       "observed_failure"
     }
  /\ LET returned ==
       IF terminalResult = "success" THEN "success" ELSE "failure"
     IN
       /\ waiterState' = [waiterState EXCEPT
            ![w] = IF returned = "success"
                   THEN "observed_success"
                   ELSE "observed_failure"]
       /\ closeCount' = [closeCount EXCEPT ![w] = @ + 1]
       /\ lastObservedResult' = [lastObservedResult EXCEPT ![w] = returned]
       /\ repeatedResultMismatch' =
            repeatedResultMismatch
              \/ (lastObservedResult[w] # "none"
                  /\ lastObservedResult[w] # returned)
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
       newWorkCount
     >>

AdmitNewWork ==
  /\ acceptingNewWork
  /\ newWorkCount = 0
  /\ newWorkCount' = 1
  /\ UNCHANGED <<
       phase,
       authorityCount,
       acceptingNewWork,
       waiterState,
       childState,
       visibleSuccesses,
       terminalResult,
       oldCanPublish,
       fenceActive,
       replacementAdmitted,
       staleEffectAccepted,
       closeCount,
       lastObservedResult,
       repeatedResultMismatch
     >>

SafeNext ==
  \/ \E w \in Waiters : BeginClose(w)
  \/ \E w \in Waiters : JoinClose(w)
  \/ \E w \in Waiters : CancelWait(w)
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

UnsafeNext ==
  \/ \E w \in Waiters : BeginClose(w)
  \/ \E w \in Waiters : JoinClose(w)
  \/ \E w \in Waiters : CancelWait(w)
  \/ \E c \in Children : SettleChildSuccess(c)
  \/ \E c \in Children : SettleChildFailure(c)
  \/ MarkReconciliation
  \/ FinishSuccess
  \/ FinishFailure
  \/ FencePriorGeneration
  \/ UnsafeAdmitReplacement
  \/ PriorGenerationPublishes
  \/ \E w \in Waiters : ObserveTerminal(w)
  \/ AdmitNewWork

Spec == Init /\ [][SafeNext]_vars
UnsafeSpec == Init /\ [][UnsafeNext]_vars

TypeOK ==
  /\ phase \in Phases
  /\ authorityCount \in 0..1
  /\ acceptingNewWork \in BOOLEAN
  /\ waiterState \in [Waiters -> WaiterStates]
  /\ childState \in [Children -> ChildStates]
  /\ visibleSuccesses \subseteq Children
  /\ terminalResult \in TerminalResults
  /\ oldCanPublish \in BOOLEAN
  /\ fenceActive \in BOOLEAN
  /\ replacementAdmitted \in BOOLEAN
  /\ staleEffectAccepted \in BOOLEAN
  /\ newWorkCount \in 0..1
  /\ closeCount \in [Waiters -> 0..2]
  /\ lastObservedResult \in [Waiters -> TerminalResults]
  /\ repeatedResultMismatch \in BOOLEAN

NoDuplicateAuthority == authorityCount <= 1

NoAdmissionAfterClosing ==
  phase # "open" => ~acceptingNewWork

CancelledWaiterDoesNotCancelSettlement ==
  (\E w \in Waiters : waiterState[w] = "cancelled")
    => authorityCount = 1 /\ phase # "open"

TerminalOwnsEveryChildOutcome ==
  phase \in TerminalPhases
    => \A c \in Children : childState[c] # "pending"

SuccessfulOutputsRemainVisible ==
  visibleSuccesses = {c \in Children : childState[c] = "success"}

ReplacementRequiresFenceOrSettlement ==
  replacementAdmitted => ~oldCanPublish

StaleGenerationCannotPublish == ~staleEffectAccepted

TerminalResultMatchesPhase ==
  /\ (phase = "settled_success" => terminalResult = "success")
  /\ (phase = "settled_failure" => terminalResult = "failure")
  /\ (phase \notin TerminalPhases => terminalResult = "none")

TerminalWaitersAgree ==
  \A w \in Waiters :
    /\ (waiterState[w] = "observed_success" => terminalResult = "success")
    /\ (waiterState[w] = "observed_failure" => terminalResult = "failure")
    /\ (lastObservedResult[w] # "none"
        => lastObservedResult[w] = terminalResult)

RepeatedCloseReturnsTerminalResult == ~repeatedResultMismatch

ReconciliationHasFailure ==
  phase = "reconciliation_required"
    => \E c \in Children : childState[c] = "failure"

TerminalClosesPriorPublication ==
  phase \in TerminalPhases => ~oldCanPublish

=============================================================================
