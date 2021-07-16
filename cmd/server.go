package cmd

import (
	"github.com/spf13/cobra"
)

func init() {
	var daemon bool

	serverCmd := &cobra.Command{
		Use:   "start",
		Short: "Start bbk",
		Run: func(cmd *cobra.Command, args []string) {
			// un implement
		},
	}
	serverCmd.Flags().BoolVarP(&daemon, "deamon", "d", false, "is daemon?")
	RootCmd.AddCommand(serverCmd)

}
