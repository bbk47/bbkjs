package cmd

import (
	"github.com/spf13/cobra"
)

var RootCmd = &cobra.Command{
	Use: "bbk",
	Run: func(cmd *cobra.Command, args []string) {
		println("bbk is a powerful tool!")
	},
}
