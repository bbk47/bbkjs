package cmd

import (
	bbk "bbk/src"
	"github.com/spf13/cobra"
)

func init() {
	var opts bbk.Option

	localCmd := &cobra.Command{
		Use:   "local",
		Short: "bbk local mode",
		Run: func(cmd *cobra.Command, args []string) {
			client := bbk.NewClient(opts)
			client.Bootstrap()
		},
	}
	localCmd.Flags().StringVarP(&opts.ListenAddr, "listen-addr", "l", "127.0.0.1", "--listen-addr 127.0.0.1")
	localCmd.Flags().IntVarP(&opts.ListenPort, "listen-port", "p", 1080, "--listen-port 1080")
	localCmd.Flags().IntVarP(&opts.Rnglen, "rnglen", "F", 0, "--rnglen 2")
	localCmd.Flags().StringVarP(&opts.LogLevel, "log-level", "L", "info", "--log-level <debug|info|warn|error|fatal>")
	localCmd.Flags().StringVarP(&opts.Method, "method", "", "aes-256-cfb", "--method <encrypt method>")
	localCmd.Flags().StringVarP(&opts.Password, "password", "", "p@ssword", "--password <encrypt password>")
	localCmd.Flags().StringVarP(&opts.WebsocketUrl, "ws-url", "w", "ws://127.0.0.1:5900/wss", "--ws-url")
	localCmd.Flags().BoolVarP(&opts.Ping, "ping", "", false, "--ping")
	RootCmd.AddCommand(localCmd)
}
