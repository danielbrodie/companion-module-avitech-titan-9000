# Avitech Titan 9000 control

Control of an Avitech Titan 9000 multiviewer through Bitfocus Companion.

## Language

**Titan session**:
A control conversation with a Titan 9000 over one TCP connection, including the device's acceptance or rejection of that connection and subsequent command traffic.
_Avoid_: Using TCP connectivity alone to mean the Titan has accepted control commands.

**Titan handshake**:
The device's initial reply accepting or rejecting a TCP client. Acceptance establishes readiness to send control commands; opening the TCP connection alone does not.

**Titan command error**:
A device-reported failure associated with command processing. A command error can coexist with an established Titan session.
