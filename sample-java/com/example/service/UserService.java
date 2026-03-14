package com.example.service;

import com.example.repository.UserRepository;

public class UserService implements Runnable {
    private final UserRepository userRepository;

    public UserService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    public void syncUsers() {
        userRepository.findAll();
    }

    @Override
    public void run() {
        syncUsers();
    }
}
