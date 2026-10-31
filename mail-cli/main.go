package main

import (
	"os"

	"mailcli/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:]))
}
