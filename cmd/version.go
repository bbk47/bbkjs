package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

func init() {
	var versionCmd = &cobra.Command{
		Use:   "version",
		Short: "Print the version number of bbk",
		Long:  `All software has versions. This is xuxihai's`,
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Println("bbk release v1.0.0 -- HEAD")
		},
	}
	RootCmd.AddCommand(versionCmd)
}
