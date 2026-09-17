# Published behavior fixtures

`baseline.json` was captured before refactoring by executing revision
`0ff9c4806e17f60f21946532037646d72b96f024` with controllable TCP and scheduling
adapters and a recording Companion host. The original command, action, feedback,
and presentation logic produced the packet bytes, logs, status transitions,
variables, and feedback values stored here.

The capture used the original source and its former VM-based test approach once.
The regression suite reads the saved results and imports the built production
modules normally; it does not regenerate expectations from the refactored code.

These are compatibility fixtures, not hardware captures or a claim that the
existing keep-alive command is a documented no-op. Deliberately preserved behavior
includes optimistic offline preset tracking, sticky command-error status, and the
absence of command acknowledgements.
