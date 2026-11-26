# Finishing a stage

The goal is a working product, not hypothetical absolute perfection. A stage is finished by these rules:

- The mandatory checks and the readiness criteria are fixed before the stage starts. Passing the mandatory checks is the
  ground for finishing it; when the criteria are met, finish the stage and move to the next.
- Checks of security, data integrity and recovery are mandatory and never skipped to speed up work.
- An additional test is allowed only for a concrete defect, a material risk or a mandatory requirement not yet verified.
- Minor remarks, optimisations, speed and test-coverage improvements go to a separate backlog task and do not block the
  stage.
- A repeat review checks that the named defects are fixed and that nothing regressed; it is not an audit of the whole
  system. The readiness criteria are not widened during acceptance without grounds.
- Looping (repeated review or test rounds on a stage whose checks passed, work that names no defect) is a defect of the
  process: stop and finish the stage by these rules.
