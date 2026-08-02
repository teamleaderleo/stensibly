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
  newWorkCount

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
  newWorkCount
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

BeginClose(w) ==
  /\ phase = "open"
  /\ waiterState[w] = "idle"
  /\ phase' = "closing"
  /\ authorityCount' = 1
  /\ acceptingNewWork' = FALSE
  /\ waiterState' = [waiterState EXCEPT ![w] = "waiting"]
  /\ UNCHANGED <<
       childState,
       visibleSuccesses,
       terminalResult,
       oldCanPublish,
       fenceActive,
       replacementAdmitted,
       staleEffectAccepted,
       newWorkCount
     >>

JoinClose(w) ==
  /\ phase \in {"closing", "reconciliation_required"}
  /\ waiterState[w] = "idle"
  /\ waiterState' = [waiterState EXCEPT ![w] = "waiting"]
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
       newWorkCount
     >>

SettleChildSuccess(c) ==
  /\ phase \in {"closing", "reconciliation_required"}
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
       newWorkCount
     >>

SettleChildFailure(c) ==
  /\ phase \in {"closing", "reconciliation_required"}
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
       newWorkCount
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
       newWorkCount
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
  /\ UNCHANGED <<
       authorityCount,
       acceptingNewWork,
       childState,
       visibleSuccesses,
       fenceActive,
       replacementAdmitted,
       staleEffectAccepted,
       newWorkCount
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
  /\ UNCHANGED <<
       authorityCount,
       acceptingNewWork,
       childState,
       visibleSuccesses,
       fenceActive,
       replacementAdmitted,
       staleEffectAccepted,
       newWorkCount
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
       newWorkCount
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
       newWorkCount
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
       newWorkCount
     >>

PriorGenerationPublishes ==
  /\ oldCanPublish
  /\ staleEffectAccepted' = staleEffectAccepted \/ replacementAdmitted
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
       newWorkCount
     >>

ObserveTerminal(w) ==
  /\ phase \in TerminalPhases
  /\ waiterState[w] \in {"idle", "waiting", "cancelled"}
  /\ waiterState' = [waiterState EXCEPT
       ![w] = IF terminalResult = "success"
              THEN "observed_success"
              ELSE "observed_failure"]
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
       staleEffectAccepted
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

ReconciliationHasFailure ==
  phase = "reconciliation_required"
    => \E c \in Children : childState[c] = "failure"

TerminalClosesPriorPublication ==
  phase \in TerminalPhases => ~oldCanPublish

=============================================================================
