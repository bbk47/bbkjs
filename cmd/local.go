package cmd

import (
	"github.com/spf13/cobra"
	"io/ioutil"
	"os/exec"
)

func init() {
	RootCmd.AddCommand(stopCmd)
}

var stopCmd = &cobra.Command{
	Use:   "stop",
	Short: "Stop bbk",
	Run: func(cmd *cobra.Command, args []string) {
		strb, _ := ioutil.ReadFile("bbk.lock")
		command := exec.Command("kill", string(strb))
		command.Start()
		println("bbk stop")
	},
}
