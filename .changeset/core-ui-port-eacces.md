---
"@hoplens/core": patch
---

The standalone UI no longer gives up when its port sits in a Windows excluded port range (Hyper-V and
WSL reserve blocks of ports, and binding one fails with `EACCES`): it moves on to the next port, as
it does for a port in use.
