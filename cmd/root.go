package cmd

import (
	bbk "bbk/src"
	"fmt"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"log"
	"os"
)

var cfgFile string

var RootCmd = &cobra.Command{
	Use: "bbk",
	Run: func(cmd *cobra.Command, args []string) {
		// Do Stuff Here
		opts := bbk.Option{
			Mode:          viper.GetString("mode"),
			ListenAddr:    viper.GetString("listenaddr"),
			ListenPort:    viper.GetInt("listenport"),
			Password:      viper.GetString("password"),
			Method:        viper.GetString("method"),
			LogLevel:      viper.GetString("logLevel"),
			WebsocketUrl:  viper.GetString("websocketUrl"),
			WebsocketPath: viper.GetString("WebsocketPath"),
			FillByte:      viper.GetInt("fillByte"),
			Ping:          viper.GetBool("ping"),
		}

		if opts.Mode != "server" && opts.Mode != "local" && opts.Mode != "client" {
			log.Fatalln("invalid mode config in ", cfgFile)
		}

		if opts.Mode == "server" {
			svr := bbk.NewServer(opts)
			svr.Bootstrap()
		} else {
			cli := bbk.NewClient(opts)
			cli.Bootstrap()

		}

	},
}

func init() {
	cobra.OnInitialize(initConfig)
	RootCmd.PersistentFlags().StringVarP(&cfgFile, "config", "c", "", "--config config.json")
}

func initConfig() {
	// Don't forget to read config either from cfgFile or from home directory!
	if cfgFile == "" {
		return
	}
	// Use config file from the flag.
	viper.SetConfigFile(cfgFile)
	if err := viper.ReadInConfig(); err != nil {
		fmt.Println("Can't read config:", err)
		os.Exit(1)
	}
}
