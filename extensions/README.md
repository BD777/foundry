# Connector extensions kept in Foundry

Data-only (declarative) connector extensions for tools Foundry supports from
the outside, through their public command line
([docs/connector-extensions.md](../docs/connector-extensions.md), 声明式扩展).
Install one on a device from the Connectors page (Add a connector → Install
from a repository: this repository, folder `extensions/<name>`) or there:

    foundry-worker extension add https://github.com/BD777/foundry.git --path extensions/limen
