package cmd

import (
	bbk "bbk/src"
	"github.com/spf13/cobra"
)

func init() {
	var opts bbk.Option

	serverCmd := &cobra.Command{
		Use:   "server",
		Short: "bbk server mode",
		Run: func(cmd *cobra.Command, args []string) {
			server := bbk.NewServer(opts)
			server.Bootstrap()
		},
	}

	serverCmd.Flags().StringVarP(&opts.ListenAddr, "listen-addr", "l", "127.0.0.1", "--listen-addr 127.0.0.1")
	serverCmd.Flags().IntVarP(&opts.ListenPort, "listen-port", "p", 5900, "--listen-port 5900")
	serverCmd.Flags().IntVarP(&opts.Rnglen, "rnglen", "F", 0, "--listen-addr 127.0.0.1")
	serverCmd.Flags().StringVarP(&opts.LogLevel, "log-level", "L", "info", "--log-level <debug|info|warn|error|fatal>")
	serverCmd.Flags().StringVarP(&opts.Method, "method", "", "aes-256-cfb", "--method <encrypt method>")
	serverCmd.Flags().StringVarP(&opts.Password, "password", "", "p@ssword", "--password <encrypt password>")
	serverCmd.Flags().StringVarP(&opts.WebsocketPath, "ws-path", "", "/wss", "--ws-path /wss")
	RootCmd.AddCommand(serverCmd)

}
